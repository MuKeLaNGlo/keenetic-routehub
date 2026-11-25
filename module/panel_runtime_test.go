package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"routehub/devicepolicy"
)

func runtimeTestRequest(handler http.HandlerFunc, key, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPut, testEditOrigin+"/api/runtime", strings.NewReader(body))
	request.Header.Set("Origin", testEditOrigin)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-RouteHub-Key", key)
	result := httptest.NewRecorder()
	handler(result, request)
	return result
}

func TestRuntimePlanSubstitutionPreservesConfiguredPolicy(t *testing.T) {
	initial := testPanelEditConfig()
	initial.DefaultTarget = selectedVPNTarget
	initial.Zapret = true
	initial.Rules = append(initial.Rules, rule{Name: "Blocked", Domain: "blocked.test", Target: "@block"})
	initial.ZapretServices = &zapretServices{YouTube: true, Discord: true}
	initial.Devices = []devicepolicy.Device{{
		MAC: "02:11:22:33:44:55", Mode: "override", DefaultTarget: selectedVPNTarget,
		Rules: []rule{{Name: "Device rule", Domain: "example.org", Target: "wire"}},
	}}
	off := runtimePlan(initial, runtimeSelection{})
	if off.DefaultTarget != "direct" || off.Rules[0].Target != "direct" ||
		off.Devices[0].DefaultTarget != "direct" || off.Devices[0].Rules[0].Target != "direct" ||
		off.Zapret || off.ZapretServices.YouTube || off.ZapretServices.Discord || off.Rules[1].Target != "@block" {
		t.Fatalf("disabled services remain on in effective plan: %+v", off)
	}
	on := runtimePlan(initial, runtimeSelection{VPN: true, Profile: "wire", Discord: true})
	if on.DefaultTarget != "wire" || on.Rules[0].Target != "relay" ||
		on.Devices[0].DefaultTarget != "wire" || on.Devices[0].Rules[0].Target != "wire" ||
		!on.Zapret || on.ZapretServices.YouTube || !on.ZapretServices.Discord {
		t.Fatalf("runtime profile disregards saved routing distinction: %+v", on)
	}
	if initial.DefaultTarget != selectedVPNTarget || initial.Rules[0].Target != "relay" ||
		initial.Devices[0].Rules[0].Target != "wire" || !initial.ZapretServices.YouTube {
		t.Fatal("effective config mutated saved routing policy")
	}
}

func TestZapretUsesServicePresetAheadOfGlobalVPNRule(t *testing.T) {
	config := testPanelEditConfig()
	config.Rules = append(config.Rules, rule{Name: "Discord through VPN", Domain: "discord.com", Target: selectedVPNTarget})
	for _, check := range []struct {
		service bool
		target  string
	}{
		{true, "zapret"},
		{false, "wire"},
	} {
		active := runtimePlan(config, runtimeSelection{VPN: true, Profile: "wire", Discord: check.service})
		result, err := active.evaluate(destination{Host: "discord.com", Network: "tcp", Port: 443})
		if err != nil || result.Target != check.target {
			t.Fatalf("Discord Zapret=%t got %+v, %v, want %s", check.service, result, err, check.target)
		}
	}
}

func TestRuntimeReloadUsesTheActiveLANHelper(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "operations")
	t.Setenv("ROUTEHUB_TEST_NETWORK_LOG", path)
	for _, name := range []string{"routehub-redirect-tcp", "routehub-transparent"} {
		helper := "#!/bin/sh\nprintf '%s %s\\n' \"${0##*/}\" \"$*\" >> \"$ROUTEHUB_TEST_NETWORK_LOG\"\n"
		if err := os.WriteFile(filepath.Join(dir, name), []byte(helper), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	opts := options{helperDir: dir}
	lan := transparent{Interface: "br0", Source: "192.168.10.0/24", Port: 18954, Mode: transparentRedirectTCP}
	engine := &engine{process: &exec.Cmd{Process: &os.Process{Pid: 321}}}
	for _, mode := range []string{transparentRedirectTCP, ""} {
		lan.Mode = mode
		if err := suspendRuntimeLAN(opts, &lan); err != nil {
			t.Fatal(err)
		}
		if err := resumeRuntimeLAN(opts, &lan, engine); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := "routehub-redirect-tcp deactivate\nroutehub-redirect-tcp activate 321\n" +
		"routehub-transparent stop\nroutehub-transparent start br0 192.168.10.0/24 18954 " + strconv.Itoa(os.Getpid()) + "\n"
	if string(data) != want {
		t.Fatalf("unexpected helper calls:\n%s\nwant:\n%s", data, want)
	}
}

func TestRuntimeControlsAreAuthorizedAndBootIsIndependent(t *testing.T) {
	config := testPanelEditConfig()
	opts := options{config: filepath.Join(t.TempDir(), "config.json")}
	controller, err := newPanelRuntime(opts)
	if err != nil {
		t.Fatal(err)
	}
	initial := controller.bootSelection(config)
	if !initial.VPN || initial.Profile != "relay" {
		t.Fatalf("legacy activation altered: %+v", initial)
	}
	controller.publish(initial, runtimeSettings{})
	want := []runtimeSelection{}
	controller.apply = func(_ context.Context, _ plan, _, next runtimeSelection) error {
		want = append(want, next)
		return nil
	}
	editor := newPanelEditor(config, testEditKey, func(context.Context, plan) error { return nil })
	for _, check := range []struct {
		name, key, body string
		handler         http.HandlerFunc
		status          int
	}{
		{"wrong auth", "wrong", `{"enabled":false}`, controller.setVPN(editor), http.StatusForbidden},
		{"unknown profile", testEditKey, `{"enabled":true,"profile":"absent"}`, controller.setVPN(editor), http.StatusBadRequest},
		{"all controls explicit", testEditKey, `{"profile":"relay"}`, controller.setVPN(editor), http.StatusBadRequest},
		{"rejected Zapret", testEditKey, `{"service":"youtube","enabled":true,"strategy":"variant-1"}`, controller.setZapret(editor), http.StatusConflict},
		{"rejected auto Zapret", testEditKey, `{"service":"discord"}`, controller.autoZapret(editor), http.StatusConflict},
		{"turn off VPN", testEditKey, `{"enabled":false}`, controller.setVPN(editor), http.StatusOK},
		{"set VPN boot", testEditKey, `{"vpn":true,"profile":"wire","zapretYouTube":false,"zapretDiscord":false}`, controller.setBoot(editor), http.StatusOK},
		{"check stored boot", testEditKey, `{}`, controller.bootCheck(editor), http.StatusOK},
	} {
		t.Run(check.name, func(t *testing.T) {
			response := runtimeTestRequest(check.handler, check.key, check.body)
			if response.Code != check.status {
				t.Fatalf("got %d, expected %d (%s)", response.Code, check.status, response.Body)
			}
			if strings.Contains(response.Body.String(), "sample-secret") {
				t.Fatal("runtime operation exposed a secret")
			}
		})
	}
	if len(want) != 1 || want[0].VPN {
		t.Fatalf("startup setting affected runtime transitions: %+v", want)
	}
	info, err := os.Stat(controller.path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("runtime settings not private: %v", err)
	}
	next, err := newPanelRuntime(opts)
	if err != nil {
		t.Fatal(err)
	}
	if boot := next.bootSelection(config); !boot.VPN || boot.Profile != "wire" || boot.zapretEnabled() {
		t.Fatalf("startup policy didn't load: %+v", boot)
	}
}

func TestRuntimeRestoresStateIfPersistenceFails(t *testing.T) {
	controller, err := newPanelRuntime(options{config: filepath.Join(t.TempDir(), "missing", "config.json")})
	if err != nil {
		t.Fatal(err)
	}
	previous, next := runtimeSelection{VPN: true, Profile: "relay"}, runtimeSelection{VPN: false, Profile: "relay"}
	controller.publish(previous, runtimeSettings{})
	var actual []runtimeSelection
	controller.apply = func(_ context.Context, _ plan, _, after runtimeSelection) error {
		actual = append(actual, after)
		return nil
	}
	got := controller.change(context.Background(), testPanelEditConfig(), next, runtimeSettings{})
	if got == nil || !reflect.DeepEqual(actual, []runtimeSelection{next, previous}) || controller.snapshot(testPanelEditConfig()).VPN.Enabled != true {
		t.Fatalf("failed save left runtime inconsistent: err %v, calls %+v", got, actual)
	}

	controller.apply = func(context.Context, plan, runtimeSelection, runtimeSelection) error { return errors.New("failed") }
	got = controller.change(context.Background(), testPanelEditConfig(), next, runtimeSettings{})
	if got == nil || got.Error() != "failed" {
		t.Fatalf("failed engine update not reported: %v", got)
	}
}

func TestRuntimeManagedStrategyScopesDiagnosticTraffic(t *testing.T) {
	dir := t.TempDir()
	opts := options{config: filepath.Join(dir, "config.json")}
	store := filepath.Join(dir, "zapret-strategies")
	if err := os.Mkdir(store, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"youtube-variant-1.args", "discord-variant-2.args"} {
		data := []byte("--lua-init=@/lab/pass.lua\n--filter-tcp=443\n--payload=tls_client_hello\n--lua-desync=passthrough\n")
		if err := os.WriteFile(filepath.Join(store, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	args, err := runtimeZapretArgs(opts,
		runtimeSelection{YouTube: true, YouTubeStrategy: "variant-1"}, zapretTrial{"discord", "variant-2"})
	if err != nil {
		t.Fatal(err)
	}
	combined := strings.Join(args, "\n")
	if strings.Count(combined, "--lua-init=") != 1 ||
		!strings.Contains(combined, "--hostlist-domains=youtube.com") ||
		!strings.Contains(combined, "--hostlist-domains=discord.com") ||
		!strings.Contains(combined, "--filter-mark=0/0x2000000") ||
		!strings.Contains(combined, "--filter-mark=0x2000000/0x2000000") {
		t.Fatalf("trial strategy does not isolate diagnostic mark: %v", args)
	}
	for _, trial := range []string{"--new=bad", "--qnum=99", "--filter-mark=0x1", "--hostlist-domains=example.org"} {
		if _, _, err := managedZapretArgs([]byte(trial + "\n--lua-desync=pass")); err == nil {
			t.Fatalf("strategy could overwrite managed limits via %s", trial)
		}
	}
	if _, err := runtimeZapretArgs(opts, runtimeSelection{YouTube: true, YouTubeStrategy: "custom"}, zapretTrial{"discord", "variant-2"}); err == nil {
		t.Fatal("trial used a misleading fallback to the legacy global strategy")
	}
}

func TestLatencyProbeUsesOnlyNamedOutbound(t *testing.T) {
	result, err := isolateProbeConfig(testPanelEditConfig().Profiles[0], 16543, "probe-user", "probe-pwd")
	if err != nil {
		t.Fatal(err)
	}
	inbounds := result["inbounds"].([]object)
	outbounds := result["outbounds"].([]object)
	if len(inbounds) != 1 || inbounds[0]["listen"] != "127.0.0.1" || len(outbounds) != 1 ||
		outbounds[0]["tag"] != "relay" || outbounds[0]["protocol"] != "trojan" {
		t.Fatalf("unexpected latency probe path: %+v %+v", inbounds, outbounds)
	}
	config, _ := json.Marshal(result)
	if strings.Contains(string(config), `"protocol":"freedom"`) {
		t.Fatal("latency probe includes direct fallback")
	}
}

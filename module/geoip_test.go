package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"testing"
)

func geoFixture(firstOctet byte) []byte {
	field := func(tag byte, data []byte) []byte {
		return append(binary.AppendUvarint([]byte{tag}, uint64(len(data))), data...)
	}
	cidr := append(field(10, []byte{firstOctet, 0, 113, 0}), 16, 24)
	return field(10, append(field(10, []byte("RU")), field(18, cidr)...))
}

type fixtureGeoTransport func(*http.Request) (*http.Response, error)

func (fixture fixtureGeoTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return fixture(request)
}

func sampleGeoSource() geoSource {
	return geoSource{ID: "sample", Name: "Sample", Repository: "https://github.com/sample/geoip", Asset: "geoip.dat", Frequency: 24}
}

func downloadFixtureGeoIP(t *testing.T, source geoSource, database []byte, version string) (geoAsset, []byte, error) {
	t.Helper()
	sum := sha256.Sum256(database)
	digest := hex.EncodeToString(sum[:])
	metadata, err := json.Marshal(object{"tag_name": version, "assets": []object{{
		"name": source.Asset, "size": len(database), "digest": "sha256:" + digest,
	}}})
	if err != nil {
		t.Fatal(err)
	}
	transport := fixtureGeoTransport(func(request *http.Request) (*http.Response, error) {
		var content []byte
		switch request.URL.String() {
		case "https://api.github.com/repos/sample/geoip/releases/latest":
			content = metadata
		case "https://github.com/sample/geoip/releases/download/" + version + "/geoip.dat":
			content = database
		default:
			t.Fatalf("unexpected GeoIP request: %s", request.URL)
		}
		return &http.Response{StatusCode: http.StatusOK, ContentLength: int64(len(content)), Body: io.NopCloser(bytes.NewReader(content))}, nil
	})
	return downloadGeoIP(context.Background(), &http.Client{Transport: transport}, source)
}

func TestGeoIPCacheRollsBackOnApplyFailure(t *testing.T) {
	source := sampleGeoSource()
	old, oldData, err := downloadFixtureGeoIP(t, source, geoFixture(203), "v1")
	if err != nil {
		t.Fatal(err)
	}
	next, nextData, err := downloadFixtureGeoIP(t, source, geoFixture(192), "v2")
	if err != nil {
		t.Fatal(err)
	}
	config := testPanelEditConfig()
	config.GeoSources = []geoSource{source}
	config.geoRoot = t.TempDir()
	var fail bool
	var applied int
	editor := newPanelEditor(config, testEditKey, func(_ context.Context, active plan) error {
		applied++
		if fail {
			return errors.New("fixture apply failure")
		}
		return nil
	})
	ctx := context.Background()
	before := editor.current().Revision
	if err := editor.installGeoIP(ctx, source, old, oldData); err != nil {
		t.Fatal(err)
	}
	if applied != 0 || editor.current().Revision != before {
		t.Fatal("loading unused GeoIP source unnecessarily applied routing")
	}
	status := editor.current().plan.geoStatus()
	if len(status) != 1 || status[0].Status != "ready" || status[0].Version != "v1" || len(status[0].Countries) != 1 || status[0].Countries[0] != "RU" {
		t.Fatalf("unexpected source status: %v", status)
	}
	editor.active.Rules = []rule{{Name: "Country", GeoIP: "RU", GeoSource: source.ID, Target: "direct"}}
	fail = true
	if err := editor.installGeoIP(ctx, source, next, nextData); err == nil || applied != 1 {
		t.Fatalf("expected apply failure, got %v and %d attempts", err, applied)
	}
	cached, err := loadGeoAsset(filepath.Join(config.geoRoot, source.ID+".cache"))
	if err != nil || cached.Digest != old.Digest || editor.current().Revision != before {
		t.Fatalf("rollback did not retain v1 cache and revision, %v", err)
	}
	fail = false
	if err := editor.installGeoIP(ctx, source, next, nextData); err != nil {
		t.Fatal(err)
	}
	cached, err = loadGeoAsset(filepath.Join(config.geoRoot, source.ID+".cache"))
	if err != nil || cached.Digest != next.Digest || editor.current().Revision == before {
		t.Fatalf("successful refresh did not publish v2, %v", err)
	}
}

func TestGeoIPSourceURLAndRedirectsStayOnGitHub(t *testing.T) {
	for _, value := range []string{
		"http://github.com/sample/geoip",
		"https://github.com@router.example/sample/geoip",
		"https://github.com:443/sample/geoip",
		"https://github.com/sample/geoip/raw/main",
		"https://github.com/sample/geoip?ref=main",
	} {
		if _, err := githubRepository(value); err == nil {
			t.Errorf("accepted unsupported repository %q", value)
		}
	}
	client := geoHTTPClient()
	if req, _ := http.NewRequest(http.MethodGet, "https://release-assets.githubusercontent.com/asset", nil); client.CheckRedirect(req, nil) != nil {
		t.Fatal("approved assets CDN blocked")
	}
	if req, _ := http.NewRequest(http.MethodGet, "https://192.0.2.1/asset", nil); client.CheckRedirect(req, nil) == nil {
		t.Fatal("unknown host accepted")
	}
}

func TestGeoSiteCacheExposesDomainTags(t *testing.T) {
	field := func(tag byte, data []byte) []byte {
		return append(binary.AppendUvarint([]byte{tag}, uint64(len(data))), data...)
	}
	domain := append([]byte{8, 2}, field(18, []byte("example.net"))...)
	data := field(10, append(field(10, []byte("RU-BLOCKED")), field(18, domain)...))
	source := sampleGeoSource()
	source.Asset = "geosite-ru-only.dat"
	digest := sha256.Sum256(data)
	database, err := parseGeoAsset(geoManifest{Repository: source.Repository, Asset: source.Asset,
		Digest: hex.EncodeToString(digest[:]), Version: "sample"}, data)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path, err := stageGeoAsset(dir, database, data)
	if err != nil {
		t.Fatal(err)
	}
	database, err = loadGeoAsset(path)
	if err != nil {
		t.Fatal(err)
	}
	config := testPanelEditConfig()
	config.GeoSources = []geoSource{source}
	config.geoAssets = map[string]geoAsset{source.ID: database}
	config.Rules = []rule{{Name: "GeoSite", GeoSite: "RU-BLOCKED", GeoSource: source.ID, Target: "relay"}}
	status := config.geoStatus()
	if len(status) != 1 || status[0].Status != "ready" || len(status[0].Sites) != 1 ||
		status[0].Sites[0] != "RU-BLOCKED" || len(status[0].Countries) != 0 {
		t.Fatalf("unexpected GeoSite status %+v", status)
	}
	decision, err := config.evaluate(destination{Host: "sub.example.net", Network: "tcp", Port: 443})
	if err != nil || decision.Target != "relay" {
		t.Fatalf("GeoSite lookup returned %+v, %v", decision, err)
	}
}

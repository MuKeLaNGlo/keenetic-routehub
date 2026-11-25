package main

import (
	"path/filepath"
	"testing"
)

func TestPackagedZapretLuaPathsFollowHelperDirectory(t *testing.T) {
	base := t.TempDir()
	for _, name := range []string{"zapret-lib.lua", "zapret-antidpi.lua"} {
		option := "--lua-init=@/opt/lib/routehub/zapret2/lua/" + name
		if got := provisionedZapretOption(option, base); got != "--lua-init=@"+filepath.Join(base, "zapret2", "lua", name) {
			t.Fatalf("incorrect path for %s: %s", name, got)
		}
		if got := provisionedZapretOption(option, ""); got != option {
			t.Fatalf("empty helper directory changed %s to %s", option, got)
		}
	}
	external := "--lua-init=@/opt/etc/routehub/zapret-lib.lua"
	if got := provisionedZapretOption(external, base); got != external {
		t.Fatalf("operator-controlled argument changed to %s", got)
	}
}

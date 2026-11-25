package main

import (
	"reflect"
	"testing"
)

func TestCompactXrayRulesPreservesOrderAndScope(t *testing.T) {
	raw := []object{
		{"type": "field", "outboundTag": "@block", "ip": []string{"192.0.2.0/24"}},
		{"type": "field", "outboundTag": "@block", "ip": []string{"198.51.100.1/32"}},
		{"type": "field", "outboundTag": "direct", "ip": []string{"203.0.113.10/32"}},
		{"type": "field", "outboundTag": "@block", "ip": []string{"203.0.113.0/24"}},
		{"type": "field", "outboundTag": "@block", "ip": []string{"192.0.2.0/24"}, "network": "tcp"},
		{"type": "field", "outboundTag": "direct", "domain": []string{"full:foo.example"}, "sourceIP": []string{"192.168.1.2/32"}},
		{"type": "field", "outboundTag": "direct", "domain": []string{"domain:bar.example"}, "sourceIP": []string{"192.168.1.2/32"}},
		{"type": "field", "outboundTag": "direct", "domain": []string{"domain:baz.example"}, "sourceIP": []string{"192.168.1.3/32"}},
	}
	result := compactXrayRules(raw)
	if len(result) != len(raw)-2 {
		t.Fatalf("expected only two merges, got %v", result)
	}
	if !reflect.DeepEqual(result[0]["ip"], []string{"192.0.2.0/24", "198.51.100.1/32"}) ||
		result[1]["outboundTag"] != "direct" ||
		!reflect.DeepEqual(result[2]["ip"], []string{"203.0.113.0/24"}) || result[3]["network"] != "tcp" ||
		!reflect.DeepEqual(result[4]["domain"], []string{"full:foo.example", "domain:bar.example"}) ||
		!reflect.DeepEqual(result[5]["sourceIP"], []string{"192.168.1.3/32"}) {
		t.Fatalf("changed rule boundaries or order: %v", result)
	}
}

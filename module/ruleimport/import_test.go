package ruleimport

import "testing"

var fixtureTargets = map[string]bool{"direct": true, "tallinn": true, "zapret": true}

func TestTextNormalizesHostsAndAddresses(t *testing.T) {
	rows, err := Parse("routes.txt", []byte("# header\nYouTube.com. > zapret\n192.0.2.4\n2001:db8::8\n192.0.2.47/24 > direct\nfull:cdn.example.org\n"), "tallinn", fixtureTargets)
	if err != nil || len(rows) != 5 {
		t.Fatalf("unexpected results %#v, %v", rows, err)
	}
	if rows[0].Domain != "youtube.com" || rows[0].Target != "zapret" ||
		rows[1].CIDR != "192.0.2.4/32" || rows[2].CIDR != "2001:db8::8/128" ||
		rows[3].CIDR != "192.0.2.0/24" || !rows[4].Exact || rows[4].Target != "tallinn" {
		t.Fatalf("unexpected normalization %#v", rows)
	}
}

func TestJSONExpandsXrayListsInOrder(t *testing.T) {
	rows, err := Parse("routes.json", []byte(`{"global_routing_rules":[
		{"type":"field","outboundTag":"zapret","domain":["domain:youtube.com","full:discord.com"],"network":"tcp","port":"443"},
		{"name":"private","ip":["10.42.0.0/16","2001:db8::1"],"outboundTag":"direct"}
	]}`), "direct", fixtureTargets)
	if err != nil || len(rows) != 4 || rows[1].Domain != "discord.com" || !rows[1].Exact ||
		rows[0].Port != 443 || rows[0].Network != "tcp" || rows[2].Name != "private 1" ||
		rows[3].CIDR != "2001:db8::1/128" {
		t.Fatalf("unexpected rules %#v, %v", rows, err)
	}
}

func TestCSVRequestsReviewOnInvalidRow(t *testing.T) {
	valid := "destination,target,name,network,port\nexample.org,tallinn,Документация,tcp,443\n"
	rows, err := Parse("routes.csv", []byte(valid), "direct", fixtureTargets)
	if err != nil || len(rows) != 1 || rows[0].Target != "tallinn" || rows[0].Port != 443 {
		t.Fatalf("unexpected rules %#v, %v", rows, err)
	}
	rows, err = Parse("routes.csv", []byte(valid+"example.com,unknown,Other,udp,53\n"), "direct", fixtureTargets)
	if err == nil || rows != nil {
		t.Fatal("an invalid row must prevent a partial import")
	}
}

func TestRejectsLossyMixedXrayRule(t *testing.T) {
	for _, data := range []string{
		`[{"domain":["example.org"],"ip":["192.0.2.1"],"outboundTag":"direct"}]`,
		`[{"domain":["geosite:youtube"],"outboundTag":"zapret"}]`,
		`[{"domain":["example.org"],"outboundTag":"direct","source":["192.0.2.0/24"]}]`,
	} {
		if rows, err := Parse("routes.json", []byte(data), "direct", fixtureTargets); err == nil || rows != nil {
			t.Fatalf("unexpected success parsing %s", data)
		}
	}
}

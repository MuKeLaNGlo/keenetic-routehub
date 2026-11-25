package devicepolicy

import (
	"net/netip"
	"testing"
)

func TestParseKeeneticSegments(t *testing.T) {
	got := parseKeeneticSegments([]byte(`Interface, name = "Имена дома"
                   id: Bridge0
                 type: Bridge
       interface-name: Имена дома
          description: Дом
                 link: up
                state: up
              address: 192.168.1.1
                 mask: 255.255.255.0
       security-level: private
               bridge:
                            id: nested-interface
                       address: 10.0.0.1
Interface, name = "Guest"
                   id: Bridge1
                 type: Bridge
       interface-name: Guest
                state: down
              address: 192.168.2.1
                 mask: 255.255.255.0
       security-level: protected
Interface, name = "ISP"
                   id: GigabitEthernet0/Vlan2
                 type: Vlan
       security-level: public
               global: yes`))
	if len(got) != 2 || got[0].ID != "Bridge0" || got[0].Name != "Дом" || got[0].Prefix != netip.MustParsePrefix("192.168.1.0/24") || got[1].State != "down" || got[1].Name != "Guest" {
		t.Fatalf("unexpected NDM topology: %+v", got)
	}
}

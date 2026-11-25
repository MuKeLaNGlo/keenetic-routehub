// Development-only oracle. Launch from the original Go module so the imported
// policy is the one actually used by the Go RouteHub daemon.
package main

import (
	"encoding/json"
	"net/netip"
	"os"

	"routehub/devicepolicy"
)

type scenarioOptions struct {
	LAN        netip.Prefix                         `json:"lan"`
	RouterIP   netip.Addr                           `json:"routerIp"`
	Targets    map[string]string                    `json:"targets"`
	Inventory  []devicepolicy.Binding               `json:"inventory"`
	GeoSources map[string]bool                      `json:"geoSources"`
	GeoData    map[string]map[string][]netip.Prefix `json:"geoData"`
	GeoSites   map[string]map[string][][2]string    `json:"geoSites"`
	GameRoutes map[string][]devicepolicy.GameRoute  `json:"gameRoutes"`
}

type scenario struct {
	Name    string                     `json:"name"`
	Config  devicepolicy.Config        `json:"config"`
	Options scenarioOptions            `json:"options"`
	Checks  []devicepolicy.Destination `json:"checks"`
	Assets  map[string]string          `json:"assets"`
}

func capture(c scenario) any {
	options := devicepolicy.Options{
		LAN: c.Options.LAN, RouterIP: c.Options.RouterIP, Targets: c.Options.Targets,
		Inventory: c.Options.Inventory, GeoSources: c.Options.GeoSources,
		GeoData: c.Options.GeoData, GeoSites: make(map[string]map[string]*devicepolicy.DomainSet),
		GameRoutes: c.Options.GameRoutes,
	}
	for id, categories := range c.Options.GeoSites {
		options.GeoSites[id] = make(map[string]*devicepolicy.DomainSet, len(categories))
		for tag, entries := range categories {
			set := &devicepolicy.DomainSet{}
			for _, row := range entries {
				if err := set.Add(row[0], row[1]); err != nil {
					panic(err)
				}
			}
			options.GeoSites[id][tag] = set
		}
	}
	plan, err := devicepolicy.Compile(c.Config, options)
	if err != nil {
		return map[string]string{"error": err.Error()}
	}
	results := make([]any, 0, len(c.Checks))
	for _, check := range c.Checks {
		decision, err := plan.Evaluate(check)
		if err != nil {
			results = append(results, map[string]string{"error": err.Error()})
		} else {
			results = append(results, decision)
		}
	}
	return map[string]any{
		"devices": plan.Devices(), "checks": results, "globalRules": plan.XrayRules(""),
		"lanRules":   plan.XrayRules("lan"),
		"assetRules": plan.XrayRulesWithAssets("lan", func(id string) string { return c.Assets[id] }),
	}
}

func main() {
	var cases []scenario
	if err := json.NewDecoder(os.Stdin).Decode(&cases); err != nil {
		panic(err)
	}
	results := make(map[string]any, len(cases))
	for _, scenario := range cases {
		results[scenario.Name] = capture(scenario)
	}
	if err := json.NewEncoder(os.Stdout).Encode(results); err != nil {
		panic(err)
	}
}

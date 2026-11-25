package devicepolicy

import (
	"regexp"
	"strings"
	"sync"
)

// GeoTag normalizes identifiers from the publisher's GeoSite or GeoIP database.
func GeoTag(raw string) (string, bool) {
	tag := strings.ToUpper(strings.TrimSpace(raw))
	if len(tag) == 0 || len(tag) > 128 || !geoTagAlphanumeric(tag[0]) {
		return "", false
	}
	for i := 1; i < len(tag); i++ {
		if char := tag[i]; !geoTagAlphanumeric(char) && char != '-' && char != '_' && char != '.' {
			return "", false
		}
	}
	return tag, true
}

func geoTagAlphanumeric(char byte) bool {
	return char >= 'A' && char <= 'Z' || char >= '0' && char <= '9'
}

// DomainSet is a compiled GeoSite category. The loader finishes building it
// before publishing the asset. Routing and Xray then share the same data.
type DomainSet struct {
	tokens   []string
	index    sync.Once
	exact    map[string]struct{}
	suffix   map[string]struct{}
	keywords []string
	patterns []*regexp.Regexp
}

func (set *DomainSet) Add(domain, match string) error {
	rule := plannedRule{Rule: Rule{Domain: domain, Match: match}}
	if err := rule.compileDomain(); err != nil {
		return err
	}
	set.tokens = append(set.tokens, rule.DomainToken)
	return nil
}

func (set *DomainSet) indexTokens() {
	for _, token := range set.tokens {
		kind, value, _ := strings.Cut(token, ":")
		switch kind {
		case "full":
			if set.exact == nil {
				set.exact = make(map[string]struct{})
			}
			set.exact[value] = struct{}{}
		case "domain":
			if set.suffix == nil {
				set.suffix = make(map[string]struct{})
			}
			set.suffix[value] = struct{}{}
		case "keyword":
			set.keywords = append(set.keywords, value)
		case "regexp":
			set.patterns = append(set.patterns, regexp.MustCompile(value))
		}
	}
}

func (set *DomainSet) matches(host string) bool {
	set.index.Do(set.indexTokens)
	if _, found := set.exact[host]; found {
		return true
	}
	if len(set.suffix) > 0 {
		for suffix := host; suffix != ""; {
			if _, found := set.suffix[suffix]; found {
				return true
			}
			_, suffix, _ = strings.Cut(suffix, ".")
		}
	}
	for _, keyword := range set.keywords {
		if strings.Contains(host, keyword) {
			return true
		}
	}
	for _, pattern := range set.patterns {
		if pattern.MatchString(host) {
			return true
		}
	}
	return false
}

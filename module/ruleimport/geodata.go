package ruleimport

import (
	"encoding/binary"
	"errors"
	"net/netip"
	"strings"
	"unicode/utf8"

	"routehub/devicepolicy"
)

var errGeodata = errors.New("повреждённая или неподдерживаемая база v2ray .dat")

type dataField struct {
	number   uint64
	wire     uint64
	unsigned uint64
	data     []byte
}

func readFields(data []byte, visit func(dataField) error) error {
	for len(data) > 0 {
		tag, size := binary.Uvarint(data)
		if size <= 0 || tag>>3 == 0 {
			return errGeodata
		}
		data = data[size:]
		field := dataField{number: tag >> 3, wire: tag & 7}
		switch field.wire {
		case 0:
			value, n := binary.Uvarint(data)
			if n <= 0 {
				return errGeodata
			}
			field.unsigned, data = value, data[n:]
		case 1, 5:
			length := 4
			if field.wire == 1 {
				length = 8
			}
			if len(data) < length {
				return errGeodata
			}
			data = data[length:]
		case 2:
			length, n := binary.Uvarint(data)
			if n <= 0 || length > uint64(len(data)-n) {
				return errGeodata
			}
			field.data, data = data[n:n+int(length)], data[n+int(length):]
		default:
			return errGeodata
		}
		if err := visit(field); err != nil {
			return err
		}
	}
	return nil
}

type datRow struct {
	ip     netip.Prefix
	domain string
	match  string
}

func parseDatRow(data []byte) (datRow, error) {
	var address netip.Addr
	var prefix, domainType uint64
	var domain string
	if err := readFields(data, func(field dataField) error {
		switch {
		case field.number == 1 && field.wire == 2:
			var ok bool
			address, ok = netip.AddrFromSlice(field.data)
			if !ok || address.Is4In6() {
				return errGeodata
			}
		case field.number == 1 && field.wire == 0:
			domainType = field.unsigned
		case field.number == 2 && field.wire == 0:
			prefix = field.unsigned
		case field.number == 2 && field.wire == 2:
			if !utf8.Valid(field.data) {
				return errGeodata
			}
			domain = string(field.data)
		}
		return nil
	}); err != nil {
		return datRow{}, err
	}
	if address.IsValid() {
		if prefix > uint64(address.BitLen()) || domain != "" {
			return datRow{}, errGeodata
		}
		return datRow{ip: netip.PrefixFrom(address, int(prefix)).Masked()}, nil
	}
	if domain == "" || domainType > 3 {
		return datRow{}, errGeodata
	}
	return datRow{domain: domain, match: [...]string{"keyword", "regex", "suffix", "exact"}[domainType]}, nil
}

func readDat(data []byte, visit func(group string, row datRow) error) error {
	var got bool
	if err := readFields(data, func(entry dataField) error {
		if entry.number != 1 || entry.wire != 2 {
			return nil
		}
		var name string
		var inverse bool
		if err := readFields(entry.data, func(field dataField) error {
			if field.number == 1 && field.wire == 2 {
				name = strings.ToUpper(string(field.data))
			}
			if field.number == 3 && field.wire == 0 && field.unsigned != 0 {
				inverse = true
			}
			return nil
		}); err != nil {
			return err
		}
		if inverse {
			return errors.New("база .dat содержит группы с обратным совпадением")
		}
		return readFields(entry.data, func(field dataField) error {
			if field.number != 2 || field.wire != 2 {
				return nil
			}
			row, err := parseDatRow(field.data)
			if err != nil {
				return err
			}
			got = true
			return visit(name, row)
		})
	}); err != nil {
		return err
	}
	if !got {
		return errGeodata
	}
	return nil
}

// GeoIP reads named address groups from an ordinary v2ray/xray GeoIP database.
// The router uses the identical prefix slices for Xray and preview decisions.
func GeoIP(data []byte) (map[string][]netip.Prefix, error) {
	groups := make(map[string][]netip.Prefix)
	if err := readDat(data, func(group string, row datRow) error {
		if !row.ip.IsValid() {
			return errGeodata
		}
		if tag, valid := devicepolicy.GeoTag(group); valid {
			groups[tag] = append(groups[tag], row.ip)
		}
		return nil
	}); err != nil {
		return nil, err
	}
	if len(groups) == 0 {
		return nil, errors.New("в базе GeoIP нет допустимых тегов")
	}
	return groups, nil
}

// GeoSite loads the compiled groups of an ordinary v2ray/xray GeoSite database.
func GeoSite(data []byte) (map[string]*devicepolicy.DomainSet, error) {
	groups := make(map[string]*devicepolicy.DomainSet)
	if err := readDat(data, func(group string, row datRow) error {
		if row.ip.IsValid() {
			return errGeodata
		}
		tag, valid := devicepolicy.GeoTag(group)
		if !valid {
			return nil
		}
		set := groups[tag]
		if set == nil {
			set = &devicepolicy.DomainSet{}
			groups[tag] = set
		}
		if err := set.Add(row.domain, row.match); err != nil {
			return errors.New("база GeoSite содержит недопустимое доменное назначение в теге " + tag)
		}
		return nil
	}); err != nil {
		return nil, err
	}
	if len(groups) == 0 {
		return nil, errors.New("в базе GeoSite нет допустимых тегов")
	}
	return groups, nil
}

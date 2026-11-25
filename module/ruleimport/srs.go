package ruleimport

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"errors"
	"io"
	"math/big"
	"net/netip"
	"strings"
	"unicode/utf8"
)

const maxInflatedSRS = 8 << 20

var errSRS = errors.New("повреждённый или неподдерживаемый список SRS")

type srsReader struct {
	data []byte
	err  error
}

func (reader *srsReader) take(size int) []byte {
	if reader.err != nil || size < 0 || size > len(reader.data) {
		reader.err = errSRS
		return nil
	}
	part := reader.data[:size]
	reader.data = reader.data[size:]
	return part
}

func (reader *srsReader) byte() byte {
	part := reader.take(1)
	if len(part) == 0 {
		return 0
	}
	return part[0]
}

func (reader *srsReader) size(max int) int {
	value, size := binary.Uvarint(reader.data)
	if size <= 0 || value > uint64(max) {
		reader.err = errSRS
		return 0
	}
	reader.take(size)
	return int(value)
}

func (reader *srsReader) vector() []byte {
	return reader.take(reader.size(len(reader.data)))
}

func (reader *srsReader) words() []byte {
	return reader.take(reader.size(len(reader.data)/8) * 8)
}

func readSRS(data []byte, emit func(destinationEntry) error) error {
	if len(data) < 5 || string(data[:3]) != "SRS" || data[3] < 1 || data[3] > 5 {
		return errSRS
	}
	inflated, err := zlib.NewReader(bytes.NewReader(data[4:]))
	if err != nil {
		return errSRS
	}
	defer inflated.Close()
	payload, err := io.ReadAll(io.LimitReader(inflated, maxInflatedSRS+1))
	if err != nil || len(payload) > maxInflatedSRS {
		return errSRS
	}
	reader := srsReader{data: payload}
	count := reader.size(maxRules)
	for i := 0; i < count && reader.err == nil; i++ {
		if reader.byte() != 0 {
			return errors.New("SRS содержит составные правила. Используйте список назначений")
		}
		if err := reader.readRule(emit); err != nil {
			return err
		}
	}
	if reader.err != nil || len(reader.data) != 0 {
		return errSRS
	}
	return nil
}

func (reader *srsReader) readRule(emit func(destinationEntry) error) error {
	for reader.err == nil {
		switch tag := reader.byte(); tag {
		case 255:
			if reader.byte() != 0 {
				return errors.New("SRS с условием исключения не является списком назначений")
			}
			return reader.err
		case 2:
			if err := reader.readDomains(emit); err != nil {
				return err
			}
		case 3, 4:
			match := "keyword"
			if tag == 4 {
				match = "regex"
			}
			count := reader.size(maxRules)
			for i := 0; i < count && reader.err == nil; i++ {
				value := reader.vector()
				if !utf8.Valid(value) {
					return errSRS
				}
				if err := emit(destinationEntry{value: string(value), match: match}); err != nil {
					return err
				}
			}
		case 6:
			if err := reader.readRanges(emit); err != nil {
				return err
			}
		default:
			return errors.New("SRS содержит условия помимо доменов или IP")
		}
	}
	return reader.err
}

func srsBit(words []byte, index int) bool {
	offset := index/64*8 + 7 - index%64/8
	return offset < len(words) && words[offset]&(1<<uint(index%8)) != 0
}

func (reader *srsReader) readDomains(emit func(destinationEntry) error) error {
	if reader.byte() != 0 {
		return errSRS
	}
	leaves, bitmap, labels := reader.words(), reader.words(), reader.vector()
	if reader.err != nil || len(labels)*2+1 > len(bitmap)*8 || len(labels)+1 > len(leaves)*8 {
		return errSRS
	}
	parents := make([]uint32, len(labels)+1)
	exact := make(map[string]bool)
	var exactOrder, suffixes []string
	edge, cursor := 0, 0
	for node := 0; node <= len(labels); node++ {
		if node > edge {
			return errSRS
		}
		if srsBit(leaves, node) {
			if len(exactOrder)+len(suffixes) >= maxRules*2 {
				return errSRS
			}
			var path []byte
			for i := node; i > 0; i = int(parents[i]) {
				if len(path) == 1024 {
					return errSRS
				}
				path = append(path, labels[i-1])
			}
			if len(path) == 0 {
				return errSRS
			}
			for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
				path[i], path[j] = path[j], path[i]
			}
			if !utf8.Valid(path) {
				return errSRS
			}
			chars := []rune(string(path))
			for i, j := 0, len(chars)-1; i < j; i, j = i+1, j-1 {
				chars[i], chars[j] = chars[j], chars[i]
			}
			value := string(chars)
			if value[0] == '\r' || value[0] == '\n' {
				suffixes = append(suffixes, value[1:])
			} else if !exact[value] {
				exact[value] = true
				exactOrder = append(exactOrder, value)
			}
		}
		for !srsBit(bitmap, cursor) {
			if edge == len(labels) {
				return errSRS
			}
			edge++
			parents[edge] = uint32(node)
			cursor++
		}
		cursor++
	}
	if edge != len(labels) {
		return errSRS
	}
	for _, value := range suffixes {
		entry := suffixEntry(value)
		if strings.HasPrefix(value, ".") && exact[value[1:]] {
			entry.match = "suffix"
			delete(exact, value[1:])
		}
		if err := emit(entry); err != nil {
			return err
		}
	}
	for _, value := range exactOrder {
		if exact[value] {
			if err := emit(destinationEntry{value: value, match: "exact"}); err != nil {
				return err
			}
		}
	}
	return nil
}

func (reader *srsReader) readRanges(emit func(destinationEntry) error) error {
	if reader.byte() != 1 {
		return errSRS
	}
	total := reader.take(8)
	if len(total) != 8 {
		return errSRS
	}
	count := binary.BigEndian.Uint64(total)
	if count > uint64(len(reader.data)/10) || count > maxRules {
		return errSRS
	}
	for i := uint64(0); i < count; i++ {
		from, to := reader.vector(), reader.vector()
		if err := emitSRSRange(from, to, emit); err != nil {
			return err
		}
	}
	return nil
}

func emitSRSRange(from, to []byte, emit func(destinationEntry) error) error {
	if len(from) != len(to) || len(from) != 4 && len(from) != 16 {
		return errSRS
	}
	base, end := new(big.Int).SetBytes(from), new(big.Int).SetBytes(to)
	if base.Cmp(end) > 0 {
		return errSRS
	}
	one := big.NewInt(1)
	length := len(from) * 8
	for base.Cmp(end) <= 0 {
		hostBits := length
		if base.Sign() != 0 {
			hostBits = int(base.TrailingZeroBits())
		}
		remaining := new(big.Int).Add(new(big.Int).Sub(end, base), one)
		hostBits = min(hostBits, remaining.BitLen()-1)
		addr, _ := netip.AddrFromSlice(base.FillBytes(make([]byte, len(from))))
		prefix := netip.PrefixFrom(addr, length-hostBits)
		if err := emit(destinationEntry{value: "ip:" + prefix.String()}); err != nil {
			return err
		}
		base.Add(base, new(big.Int).Lsh(one, uint(hostBits)))
	}
	return nil
}

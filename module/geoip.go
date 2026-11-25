package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"routehub/devicepolicy"
	"routehub/ruleimport"
)

const geoMaxBytes = 32 << 20

type geoSource struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Repository string `json:"repository"`
	Asset      string `json:"asset"`
	Frequency  int    `json:"frequency"`
	Auto       bool   `json:"auto"`
}

type geoManifest struct {
	Repository string    `json:"repository"`
	Asset      string    `json:"asset"`
	Version    string    `json:"version"`
	UpdatedAt  time.Time `json:"updatedAt"`
	Digest     string    `json:"digest"`
}

type geoAsset struct {
	geoManifest
	Countries map[string][]netip.Prefix
	Sites     map[string]*devicepolicy.DomainSet
}

type geoStatus struct {
	ID        string     `json:"id"`
	Status    string     `json:"status"`
	Version   string     `json:"version,omitempty"`
	UpdatedAt *time.Time `json:"updatedAt,omitempty"`
	Countries []string   `json:"countries,omitempty"`
	Sites     []string   `json:"sites,omitempty"`
}

var githubPart = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$`)
var geoAssetName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.dat$`)
var geoUpdates = make(chan struct{}, 1)
var errGeoBusy = errors.New("дождитесь завершения текущего обновления GeoIP")

func githubRepository(value string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme != "https" || parsed.Host != "github.com" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" || parsed.RawPath != "" {
		return "", errors.New("укажите репозиторий в формате https://github.com/owner/repo")
	}
	path := strings.Trim(parsed.Path, "/")
	owner, repository, cut := strings.Cut(path, "/")
	if !cut || !githubPart.MatchString(owner) || !githubPart.MatchString(repository) {
		return "", errors.New("укажите репозиторий в формате https://github.com/owner/repo")
	}
	return owner + "/" + repository, nil
}

func validateGeoSources(sources []geoSource) ([]geoSource, error) {
	seen := make(map[string]bool)
	sources = slices.Clone(sources)
	for i, source := range sources {
		if !validDomain(source.ID) || strings.Contains(source.ID, ".") || seen[source.ID] {
			return nil, errors.New("ID источников GeoIP должны быть уникальными")
		}
		seen[source.ID] = true
		source.Name = strings.TrimSpace(source.Name)
		if source.Name == "" || len([]rune(source.Name)) > 100 {
			return nil, errors.New("укажите название источника GeoIP до 100 символов")
		}
		repository, err := githubRepository(source.Repository)
		if err != nil {
			return nil, err
		}
		source.Repository = "https://github.com/" + repository
		if !geoAssetName.MatchString(source.Asset) {
			return nil, errors.New("укажите имя файла базы GeoIP с расширением .dat")
		}
		if source.Frequency == 0 {
			source.Frequency = 24
		}
		switch source.Frequency {
		case 6, 12, 24, 48, 168:
		default:
			return nil, errors.New("интервал GeoIP доступен на 6, 12, 24, 48 или 168 часов")
		}
		sources[i] = source
	}
	return sources, nil
}

func (asset geoAsset) matches(source geoSource) bool {
	return asset.Repository == source.Repository && asset.Asset == source.Asset && (len(asset.Countries) != 0 || len(asset.Sites) != 0)
}

func parseGeoAsset(manifest geoManifest, data []byte) (geoAsset, error) {
	result := geoAsset{geoManifest: manifest}
	var err error
	name := strings.ToLower(manifest.Asset)
	if name == "geosite.dat" || strings.HasPrefix(name, "geosite-") {
		result.Sites, err = ruleimport.GeoSite(data)
	} else {
		result.Countries, err = ruleimport.GeoIP(data)
	}
	return result, err
}

func (config plan) geoStatus() []geoStatus {
	results := make([]geoStatus, 0, len(config.GeoSources))
	for _, source := range config.GeoSources {
		status := geoStatus{ID: source.ID, Status: "missing"}
		if asset := config.geoAssets[source.ID]; asset.matches(source) {
			status.Status, status.Version, status.UpdatedAt = "ready", asset.Version, &asset.UpdatedAt
			for code := range asset.Countries {
				status.Countries = append(status.Countries, code)
			}
			for tag := range asset.Sites {
				status.Sites = append(status.Sites, tag)
			}
			slices.Sort(status.Countries)
			slices.Sort(status.Sites)
		}
		results = append(results, status)
	}
	return results
}

func geoHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	return &http.Client{
		Transport: transport,
		Timeout:   25 * time.Second,
		CheckRedirect: func(request *http.Request, previous []*http.Request) error {
			if len(previous) > 5 || request.URL.Scheme != "https" || request.URL.Port() != "" || request.URL.User != nil {
				return errors.New("недопустимая переадресация файла GeoIP")
			}
			switch request.URL.Hostname() {
			case "github.com", "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com":
				return nil
			default:
				return errors.New("файл GeoIP должен загружаться с GitHub Releases")
			}
		},
	}
}

func readGeoResponse(ctx context.Context, client *http.Client, address, accept string, limit int64) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, errors.New("проверьте адрес источника GeoIP")
	}
	request.Header.Set("Accept", accept)
	request.Header.Set("User-Agent", "RouteHub-GeoIP")
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("не удалось загрузить данные из GitHub Releases")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub Releases ответил HTTP %d", response.StatusCode)
	}
	if response.ContentLength > limit {
		return nil, errors.New("размер базы GeoIP превышает допустимый")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("не удалось прочитать файл GeoIP допустимого размера")
	}
	return data, nil
}

func downloadGeoIP(ctx context.Context, client *http.Client, source geoSource) (geoAsset, []byte, error) {
	repository, err := githubRepository(source.Repository)
	if err != nil {
		return geoAsset{}, nil, err
	}
	info, err := readGeoResponse(ctx, client, "https://api.github.com/repos/"+repository+"/releases/latest", "application/vnd.github+json", 2<<20)
	if err != nil {
		return geoAsset{}, nil, err
	}
	var release struct {
		Version string `json:"tag_name"`
		Assets  []struct {
			Name   string `json:"name"`
			Size   int64  `json:"size"`
			Digest string `json:"digest"`
		} `json:"assets"`
	}
	if json.Unmarshal(info, &release) != nil || release.Version == "" || len(release.Version) > 128 {
		return geoAsset{}, nil, errors.New("GitHub не вернул сведения о последнем релизе")
	}
	for _, asset := range release.Assets {
		if asset.Name != source.Asset {
			continue
		}
		if asset.Size <= 0 || asset.Size > geoMaxBytes {
			return geoAsset{}, nil, errors.New("размер файла базы должен быть от 1 байта до 32 МиБ")
		}
		address := "https://github.com/" + repository + "/releases/download/" + url.PathEscape(release.Version) + "/" + source.Asset
		data, err := readGeoResponse(ctx, client, address, "application/octet-stream", geoMaxBytes)
		if err != nil {
			return geoAsset{}, nil, err
		}
		sum := sha256.Sum256(data)
		digest := hex.EncodeToString(sum[:])
		if int64(len(data)) != asset.Size || (asset.Digest != "" && asset.Digest != "sha256:"+digest) {
			return geoAsset{}, nil, errors.New("размер или SHA-256 базы не совпал с релизом GitHub")
		}
		database, err := parseGeoAsset(geoManifest{
			Repository: source.Repository, Asset: source.Asset, Version: release.Version,
			UpdatedAt: time.Now().UTC(), Digest: digest,
		}, data)
		if err != nil {
			return geoAsset{}, nil, err
		}
		return database, data, nil
	}
	return geoAsset{}, nil, errors.New("в последнем релизе GitHub нет выбранного файла GeoIP")
}

func loadGeoAssets(dir string, sources []geoSource) map[string]geoAsset {
	assets := make(map[string]geoAsset)
	for _, source := range sources {
		asset, err := loadGeoAsset(filepath.Join(dir, source.ID+".cache"))
		if err == nil && asset.matches(source) {
			assets[source.ID] = asset
		}
	}
	return assets
}

func openGeoCache(path string) (*os.File, *bufio.Reader, geoManifest, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, geoManifest{}, err
	}
	reader := bufio.NewReader(io.LimitReader(file, geoMaxBytes+8192))
	header, err := reader.ReadSlice('\n')
	var manifest geoManifest
	if err != nil || json.Unmarshal(header, &manifest) != nil {
		_ = file.Close()
		return nil, nil, geoManifest{}, errors.New("не удалось прочитать заголовок базы GeoIP")
	}
	return file, reader, manifest, nil
}

func loadGeoAsset(path string) (geoAsset, error) {
	file, reader, manifest, err := openGeoCache(path)
	if err != nil {
		return geoAsset{}, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(reader, geoMaxBytes+1))
	if err != nil || len(data) > geoMaxBytes {
		return geoAsset{}, errors.New("не удалось прочитать файл GeoIP")
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != manifest.Digest {
		return geoAsset{}, errors.New("не совпала контрольная сумма базы GeoIP")
	}
	return parseGeoAsset(manifest, data)
}

func stageGeoAsset(dir string, asset geoAsset, data []byte) (string, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	file, err := os.CreateTemp(dir, ".geoip-next-")
	if err != nil {
		return "", err
	}
	err = json.NewEncoder(file).Encode(asset.geoManifest)
	if err == nil {
		_, err = file.Write(data)
	}
	err = errors.Join(err, file.Sync(), file.Close())
	if err != nil {
		_ = os.Remove(file.Name())
		return "", err
	}
	return file.Name(), nil
}

func (editor *panelEditor) geoIPStatus(response http.ResponseWriter, _ *http.Request) {
	sendJSON(response, http.StatusOK, object{"sources": editor.current().plan.geoStatus()})
}

func (editor *panelEditor) updateGeoIP(response http.ResponseWriter, request *http.Request) {
	if !editor.authorized(request) {
		sendJSON(response, http.StatusForbidden, object{"error": "Доступ к обновлению GeoIP запрещён"})
		return
	}
	var input struct {
		ID string `json:"id"`
	}
	if err := decodeJSON(http.MaxBytesReader(response, request.Body, 1024), &input); err != nil || input.ID == "" {
		sendJSON(response, http.StatusBadRequest, object{"error": "укажите источник GeoIP"})
		return
	}
	if err := editor.refreshGeoIP(request.Context(), input.ID); err != nil {
		code := http.StatusUnprocessableEntity
		if errors.Is(err, errGeoBusy) {
			code = http.StatusTooManyRequests
		}
		sendJSON(response, code, object{"error": err.Error()})
		return
	}
	current := editor.current()
	sendJSON(response, http.StatusOK, object{"sources": current.plan.geoStatus(), "revision": current.Revision})
}

func (editor *panelEditor) refreshGeoIP(ctx context.Context, id string) error {
	select {
	case geoUpdates <- struct{}{}:
		defer func() { <-geoUpdates }()
	default:
		return errGeoBusy
	}
	config := editor.current().plan
	sourceIndex := slices.IndexFunc(config.GeoSources, func(source geoSource) bool { return source.ID == id })
	if sourceIndex < 0 || config.geoRoot == "" {
		return errors.New("источник GeoIP не найден")
	}
	source := config.GeoSources[sourceIndex]
	client := geoHTTPClient()
	defer client.CloseIdleConnections()
	downloadContext, cancel := context.WithTimeout(ctx, 35*time.Second)
	asset, data, err := downloadGeoIP(downloadContext, client, source)
	cancel()
	if err != nil {
		return err
	}
	return editor.installGeoIP(ctx, source, asset, data)
}

func (editor *panelEditor) installGeoIP(ctx context.Context, source geoSource, asset geoAsset, data []byte) error {
	editor.editMutex.Lock()
	defer editor.editMutex.Unlock()
	if ctx.Err() != nil {
		return errors.New("обновление GeoIP отменено")
	}
	current := editor.current()
	if !slices.Contains(current.GeoSources, source) {
		return errors.New("источник GeoIP изменился. Запустите обновление снова")
	}
	next := current.plan
	next.geoAssets = maps.Clone(next.geoAssets)
	if next.geoAssets == nil {
		next.geoAssets = make(map[string]geoAsset)
	}
	previous := next.geoAssets[source.ID]
	next.geoAssets[source.ID] = asset
	if _, err := next.policy(true); err != nil {
		return errors.New("в обновлённой базе отсутствуют теги, используемые в активных правилах")
	}
	staged, err := stageGeoAsset(next.geoRoot, asset, data)
	if err != nil {
		return errors.New("не удалось записать базу GeoIP")
	}
	defer os.Remove(staged)
	path := filepath.Join(next.geoRoot, source.ID+".cache")
	old := staged + ".previous"
	hasOld := false
	if err := os.Link(path, old); err == nil {
		hasOld = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return errors.New("не удалось сохранить предыдущую базу GeoIP")
	}
	defer os.Remove(old)
	if err := os.Rename(staged, path); err != nil {
		return errors.New("не удалось заменить базу GeoIP")
	}
	revision := current.Revision
	if previous.Digest != asset.Digest && usesGeoIP(next, source.ID) {
		if editor.apply == nil || editor.apply(ctx, copyPanelPlan(next)) != nil {
			var rollback error
			if hasOld {
				rollback = os.Rename(old, path)
			} else {
				rollback = os.Remove(path)
			}
			if rollback != nil {
				return errors.New("не удалось применить базу GeoIP и вернуть предыдущий файл")
			}
			return errors.New("не удалось применить базу GeoIP. Активная база восстановлена")
		}
		revision = newPanelRevision()
	}
	editor.stateMutex.Lock()
	editor.active = versionedPlan{plan: next, Revision: revision}
	editor.stateMutex.Unlock()
	return nil
}

func usesGeoIP(config plan, source string) bool {
	needed := func(candidate rule) bool {
		return !candidate.Disabled && (candidate.GeoIP != "" || candidate.GeoSite != "") && candidate.GeoSource == source
	}
	if slices.ContainsFunc(config.Rules, needed) {
		return true
	}
	for _, device := range config.Devices {
		if device.Mode != "global" && device.Mode != "fixed" && slices.ContainsFunc(device.Rules, needed) {
			return true
		}
	}
	return false
}

func (editor *panelEditor) watchGeoIP(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	attempts := make(map[string]time.Time)
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			config := editor.current().plan
			for _, source := range config.GeoSources {
				if !source.Auto || now.Sub(attempts[source.ID]) < 15*time.Minute {
					continue
				}
				asset := config.geoAssets[source.ID]
				if asset.matches(source) && now.Sub(asset.UpdatedAt) < time.Duration(source.Frequency)*time.Hour {
					continue
				}
				attempts[source.ID] = now
				_ = editor.refreshGeoIP(ctx, source.ID)
			}
		}
	}
}

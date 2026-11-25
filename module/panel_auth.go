package main

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	panelCookie         = "routehub_session"
	panelSessionLife    = 12 * time.Hour
	panelPasswordRounds = 600_000
)

type panelCredential struct {
	Version int    `json:"version"`
	Salt    []byte `json:"salt"`
	Digest  []byte `json:"digest"`
}

type panelAttempts struct {
	count int
	until time.Time
}

type panelAuth struct {
	mu         sync.Mutex
	path       string
	key        [sha256.Size]byte
	credential *panelCredential
	available  bool
	sessions   map[[sha256.Size]byte]time.Time
	attempts   map[string]panelAttempts
}

func newPanelAuth(path, initial string) *panelAuth {
	a := &panelAuth{
		path: path, key: sha256.Sum256([]byte(initial)), available: initial != "",
		sessions: make(map[[sha256.Size]byte]time.Time), attempts: make(map[string]panelAttempts),
	}
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return a
	}
	if err != nil {
		a.available = false
		return a
	}
	defer f.Close()
	info, err := f.Stat()
	var credential panelCredential
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > 1024 ||
		decodeJSON(io.LimitReader(f, 1025), &credential) != nil ||
		credential.Version != 1 || len(credential.Salt) != 16 || len(credential.Digest) != sha256.Size {
		a.available = false
		return a
	}
	a.credential = &credential
	a.available = true
	return a
}

func panelPasswordHash(password string, salt []byte) []byte {
	digest, _ := pbkdf2.Key(sha256.New, password, salt, panelPasswordRounds, sha256.Size)
	return digest
}

func (a *panelAuth) verify(password string) bool {
	if a.credential == nil {
		digest := sha256.Sum256([]byte(password))
		return subtle.ConstantTimeCompare(digest[:], a.key[:]) == 1
	}
	digest := panelPasswordHash(password, a.credential.Salt)
	return subtle.ConstantTimeCompare(digest, a.credential.Digest) == 1
}

func (a *panelAuth) token(r *http.Request) [sha256.Size]byte {
	if cookie, err := r.Cookie(panelCookie); err == nil && len(cookie.Value) == 64 {
		return sha256.Sum256([]byte(cookie.Value))
	}
	return [sha256.Size]byte{}
}

func (a *panelAuth) valid(r *http.Request) bool {
	if a == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.validLocked(r)
}

func (a *panelAuth) validLocked(r *http.Request) bool {
	return a.available && a.sessions[a.token(r)].After(time.Now())
}

func panelSameOrigin(r *http.Request) bool {
	scheme := "http://"
	if r.TLS != nil {
		scheme = "https://"
	}
	return r.Header.Get("Origin") == scheme+r.Host
}

func panelSetCookie(w http.ResponseWriter, r *http.Request, token string, age int) {
	http.SetCookie(w, &http.Cookie{
		Name: panelCookie, Value: token, Path: "/", HttpOnly: true,
		SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil, MaxAge: age,
	})
}

func (a *panelAuth) issue(w http.ResponseWriter, r *http.Request, now time.Time) bool {
	for token, expiry := range a.sessions {
		if !expiry.After(now) {
			delete(a.sessions, token)
		}
	}
	delete(a.sessions, a.token(r))
	if len(a.sessions) >= 64 {
		return false
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return false
	}
	token := hex.EncodeToString(raw[:])
	a.sessions[sha256.Sum256([]byte(token))] = now.Add(panelSessionLife)
	panelSetCookie(w, r, token, int(panelSessionLife.Seconds()))
	return true
}

func (a *panelAuth) status(w http.ResponseWriter, r *http.Request) {
	if a == nil || !a.available {
		sendJSON(w, http.StatusOK, object{"status": "unavailable", "error": "На роутере не настроен доступ к панели"})
		return
	}
	status := "signed-out"
	if a.valid(r) {
		status = "signed-in"
	}
	sendJSON(w, http.StatusOK, object{"status": status})
}

func writePanelPrivate(path string, value any) error {
	pending, err := privateJSON(filepath.Dir(path), "."+filepath.Base(path)+".*", value)
	if err != nil {
		return err
	}
	defer os.Remove(pending)
	return os.Rename(pending, path)
}

func (a *panelAuth) session(w http.ResponseWriter, r *http.Request) {
	if !panelSameOrigin(r) {
		sendJSON(w, http.StatusForbidden, object{"error": "Запрос должен исходить из панели"})
		return
	}
	if a == nil || !a.available {
		sendJSON(w, http.StatusServiceUnavailable, object{"error": "На роутере не настроен доступ к панели"})
		return
	}
	if r.Method == http.MethodDelete {
		a.mu.Lock()
		delete(a.sessions, a.token(r))
		a.mu.Unlock()
		panelSetCookie(w, r, "", -1)
		sendJSON(w, http.StatusOK, object{"status": "signed-out"})
		return
	}
	var body struct {
		Password        string `json:"password"`
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	change := r.Method == http.MethodPut
	if err := decodeJSON(http.MaxBytesReader(w, r.Body, 4096), &body); err != nil ||
		len(body.Password) > 256 || len(body.CurrentPassword) > 256 || len(body.NewPassword) > 256 {
		sendJSON(w, http.StatusBadRequest, object{"error": "Некорректный запрос пароля"})
		return
	}
	if change && (len([]rune(body.NewPassword)) < 8 || strings.TrimSpace(body.NewPassword) == "" || body.NewPassword == body.CurrentPassword) {
		sendJSON(w, http.StatusBadRequest, object{"error": "Укажите новый пароль длиной от 8 символов"})
		return
	}
	peer, _, _ := net.SplitHostPort(r.RemoteAddr)
	now := time.Now()
	a.mu.Lock()
	defer a.mu.Unlock()
	if change && !a.validLocked(r) {
		sendJSON(w, http.StatusUnauthorized, object{"error": "Войдите в панель"})
		return
	}
	for addr, attempt := range a.attempts {
		if !attempt.until.After(now) {
			delete(a.attempts, addr)
		}
	}
	attempt := a.attempts[peer]
	if attempt.count >= 6 || (attempt.count == 0 && len(a.attempts) >= 128) {
		w.Header().Set("Retry-After", "60")
		sendJSON(w, http.StatusTooManyRequests, object{"error": "Слишком много попыток. Повторите через минуту"})
		return
	}
	password := body.Password
	if change {
		password = body.CurrentPassword
	}
	if !a.verify(password) {
		if attempt.count == 0 {
			attempt.until = now.Add(time.Minute)
		}
		attempt.count++
		a.attempts[peer] = attempt
		sendJSON(w, http.StatusUnauthorized, object{"error": "Неверный пароль"})
		return
	}
	delete(a.attempts, peer)
	if change {
		credential := panelCredential{Version: 1, Salt: make([]byte, 16)}
		if _, err := rand.Read(credential.Salt); err != nil {
			sendJSON(w, http.StatusInternalServerError, object{"error": "Не удалось обновить пароль"})
			return
		}
		credential.Digest = panelPasswordHash(body.NewPassword, credential.Salt)
		if err := writePanelPrivate(a.path, credential); err != nil {
			sendJSON(w, http.StatusInternalServerError, object{"error": "Не удалось сохранить пароль"})
			return
		}
		a.credential = &credential
		clear(a.sessions)
	}
	if !a.issue(w, r, now) {
		sendJSON(w, http.StatusServiceUnavailable, object{"error": "Не удалось создать сессию"})
		return
	}
	sendJSON(w, http.StatusOK, object{"status": "signed-in"})
}

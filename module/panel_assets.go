package main

import (
	"embed"
	"net/http"
)

//go:embed panel/dist/index.html index.html panel_traffic.js
var panelAssets embed.FS

const panelContentPolicy = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"

func registerPanelAssets(mux *http.ServeMux) {
	mux.HandleFunc("GET /{$}", func(response http.ResponseWriter, request *http.Request) {
		http.ServeFileFS(response, request, panelAssets, "panel/dist/index.html")
	})
	mux.HandleFunc("GET /legacy", func(response http.ResponseWriter, request *http.Request) {
		http.ServeFileFS(response, request, panelAssets, "index.html")
	})
	mux.HandleFunc("GET /panel-traffic.js", func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		http.ServeFileFS(response, request, panelAssets, "panel_traffic.js")
	})
}

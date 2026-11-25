(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const WINDOW_MINUTES = [5, 15, 60];
  const REFRESH_MS = 5000;
  const VIEW = { width: 520, height: 230, left: 47, right: 18, top: 16, bottom: 26 };
  const RATE = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
  const PERCENT = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  const TIME = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });

  function element(name, attributes, text) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function finiteRate(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }

  function parseSnapshot(payload) {
    if (payload === null || typeof payload !== "object" || !Array.isArray(payload.samples)) {
      throw new Error("Некорректные данные трафика");
    }
    const samples = new Map();
    for (const sample of payload.samples) {
      if (sample === null || typeof sample !== "object" || typeof sample.at !== "string") continue;
      const time = Date.parse(sample.at);
      if (Number.isFinite(time) && finiteRate(sample.receiveMbit) && finiteRate(sample.sendMbit)) {
        samples.set(time, { time, receive: sample.receiveMbit, send: sample.sendMbit });
      }
    }
    return {
      name: typeof payload.interface === "string" ? payload.interface : "",
      linkSpeed: finiteRate(payload.linkMbit) && payload.linkMbit > 0 ? payload.linkMbit : null,
      samples: Array.from(samples.values()).sort((left, right) => left.time - right.time),
    };
  }

  function axisCeiling(peak) {
    if (peak === 0) return 1;
    const step = Math.max(peak / 4, 0.01);
    const magnitude = 10 ** Math.floor(Math.log10(step));
    for (const multiple of [1, 2, 2.5, 5, 10]) {
      const limit = multiple * magnitude * 4;
      if (Number.isFinite(limit) && limit >= peak) return limit;
    }
    return peak;
  }

  function text(container, value) {
    if (container && container.textContent !== value) container.textContent = value;
  }

  function updatePlot(svg, content, changePeriod) {
    const current = svg.lastElementChild;
    if (current && (!changePeriod || window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
        !current.querySelector("path") || !content.querySelector("path"))) {
      current.replaceChildren(content);
      return;
    }

    const next = element("g", {});
    next.append(content);
    if (!current) {
      svg.replaceChildren(next);
      return;
    }

    const opacity = getComputedStyle(current).opacity;
    for (const animation of current.getAnimations()) animation.cancel();
    current.setAttribute("aria-hidden", "true");
    svg.replaceChildren(current, next);
    const timing = { duration: 290, easing: "cubic-bezier(.2,.75,.2,1)" };
    current.animate([{ opacity }, { opacity: 0 }], timing).onfinish = () => current.remove();
    next.animate([{ opacity: 0 }, { opacity: 1 }], timing);
  }

  function drawChart(svg, snapshot, minutes, emptyMessage, stale, changePeriod) {
    if (!svg) return;

    const { width, height, left, right, top, bottom } = VIEW;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const baseline = height - bottom;
    const foreground = "var(--muted-foreground, var(--muted, #596579))";
    const grid = "var(--line, var(--border, #dce3ed))";
    const label = `Трафик WAN за последние ${minutes} мин`;

    const latest = snapshot?.samples.at(-1);
    const layer = document.createDocumentFragment();
    if (!latest) {
      svg.setAttribute("aria-label", emptyMessage);
      layer.append(element("text", {
        x: width / 2, y: height / 2, "text-anchor": "middle",
        fill: foreground, "font-size": 14,
      }, emptyMessage));
      updatePlot(svg, layer, false);
      return;
    }
    svg.setAttribute("aria-label", stale ? `${label}. Последние доступные данные` : label);

    const duration = minutes * 60 * 1000;
    const from = latest.time - duration;
    const samples = snapshot.samples.filter((sample) => sample.time >= from);
    const peak = samples.reduce((maximum, sample) => Math.max(maximum, sample.receive, sample.send), 0);
    const ceiling = axisCeiling(peak);
    const x = (timestamp) => left + ((timestamp - from) / duration) * plotWidth;
    const y = (rate) => baseline - (rate / ceiling) * plotHeight;

    layer.append(element("title", {}, `${label}. Приём ${RATE.format(latest.receive)}, отдача ${RATE.format(latest.send)} Мбит/с.`));
    for (let tick = 0; tick <= 4; tick++) {
      const ordinate = top + (tick * plotHeight) / 4;
      const rate = ceiling * (1 - tick / 4);
      layer.append(
        element("line", { x1: left, x2: width - right, y1: ordinate, y2: ordinate, stroke: grid }),
        element("text", {
          x: left - 8, y: ordinate + 4, fill: foreground, "text-anchor": "end",
          "font-size": 11, "font-family": "var(--mono, monospace)",
        }, RATE.format(rate)),
      );
    }
    for (let tick = 0; tick <= 4; tick++) {
      const timestamp = from + (tick * duration) / 4;
      const alignment = tick === 0 ? "start" : tick === 4 ? "end" : "middle";
      layer.append(element("text", {
        x: x(timestamp), y: height - 7, fill: foreground, "text-anchor": alignment,
        "font-size": 11, "font-family": "var(--mono, monospace)",
      }, TIME.format(timestamp)));
    }

    for (const [field, color, stroke] of [
      ["receive", "var(--download, #147e72)", 2.4],
      ["send", "var(--upload, #6159b9)", 1.8],
    ]) {
      let previous = null;
      const path = samples.map((sample) => {
        const command = previous === null || sample.time - previous > REFRESH_MS * 4 ? "M" : "L";
        previous = sample.time;
        return `${command}${x(sample.time).toFixed(1)},${y(sample[field]).toFixed(1)}`;
      }).join(" ");
      layer.append(
        element("path", { d: path, fill: "none", stroke: color, "stroke-width": stroke, "stroke-linecap": "round", "stroke-linejoin": "round" }),
        element("circle", { cx: x(latest.time), cy: y(latest[field]), r: 3, fill: color }),
      );
    }
    updatePlot(svg, layer, changePeriod);
  }

  function initialize() {
    const panel = document.getElementById("traffic-panel");
    if (!panel) return;

    const receive = panel.querySelector('[data-traffic-rate="receive"]');
    const send = panel.querySelector('[data-traffic-rate="send"]');
    const utilization = panel.querySelector("[data-traffic-utilization]");
    const utilizationWrap = panel.querySelector("[data-traffic-utilization-wrap]") || utilization;
    const device = panel.querySelector("[data-traffic-interface]");
    const state = panel.querySelector("[data-traffic-status]");
    const periods = panel.querySelector(".periods");
    const controls = Array.from(periods?.querySelectorAll("button[data-traffic-window]") || []);
    const chart = panel.querySelector("[data-traffic-chart]");
    let svg = null;
    if (chart) {
      svg = chart.localName === "svg" ? chart : element("svg", { width: "100%" });
      svg.setAttribute("width", "100%");
      svg.setAttribute("role", "img");
      svg.setAttribute("viewBox", `0 0 ${VIEW.width} ${VIEW.height}`);
      if (svg !== chart) chart.replaceChildren(svg);
    }

    const preferred = Number(controls.find((button) => button.getAttribute("aria-pressed") === "true")?.dataset.trafficWindow);
    let minutes = WINDOW_MINUTES.includes(preferred) ? preferred : 15;
    let snapshot = null;
    let failed = false;
    let pending = false;
    let timer;

    function render(changePeriod = false) {
      const latest = snapshot?.samples.at(-1);
      text(receive, latest ? RATE.format(latest.receive) : "—");
      text(send, latest ? RATE.format(latest.send) : "—");
      if (utilizationWrap) {
        const available = Boolean(latest && snapshot.linkSpeed);
        utilizationWrap.hidden = !available;
        if (available) {
          const rate = Math.max(latest.receive, latest.send);
          const percentage = Math.min(100, (rate / snapshot.linkSpeed) * 100);
          text(utilization, `${PERCENT.format(percentage)} %`);
        }
      }
      if (device) {
        device.hidden = !snapshot?.name;
        text(device, snapshot?.name || "");
      }

      let message = "Загружаем данные о трафике";
      if (failed) {
        message = latest ? `Трафик временно недоступен. Последние показания в ${TIME.format(latest.time)}.` : "Данные о трафике недоступны.";
      } else if (snapshot) {
        if (latest) message = `Последние показания WAN в ${TIME.format(latest.time)}`;
        else message = snapshot.name ? "Собираем данные о трафике" : "Интерфейс WAN пока не определён";
      }
      text(state, message);
      drawChart(svg, snapshot, minutes, message, failed, changePeriod);
    }

    function schedule() {
      window.clearTimeout(timer);
      if (!document.hidden && panel.isConnected) timer = window.setTimeout(refresh, REFRESH_MS);
    }

    async function refresh() {
      if (pending || document.hidden || !panel.isConnected) return;
      pending = true;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), REFRESH_MS);
      try {
        const response = await fetch("/api/traffic", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Данные о трафике недоступны");
        snapshot = parseSnapshot(await response.json());
        failed = false;
      } catch {
        failed = true;
      } finally {
        window.clearTimeout(timeout);
        pending = false;
        render();
        schedule();
      }
    }

    function selectWindow(value) {
      const changePeriod = value !== minutes;
      minutes = value;
      periods?.style.setProperty("--period-index", String(WINDOW_MINUTES.indexOf(value)));
      for (const button of controls) {
        const selected = Number(button.dataset.trafficWindow) === value;
        button.setAttribute("aria-pressed", String(selected));
        button.dataset.state = selected ? "on" : "off";
      }
      render(changePeriod);
    }

    for (const button of controls) {
      const value = Number(button.dataset.trafficWindow);
      if (WINDOW_MINUTES.includes(value)) button.addEventListener("click", () => selectWindow(value));
    }
    document.addEventListener("visibilitychange", () => {
      window.clearTimeout(timer);
      if (!document.hidden) refresh();
    });
    selectWindow(minutes);
    refresh();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();

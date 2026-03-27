/**
 * VOZILO IoT — Node.js Backend v1.0.0
 */

const WebSocket = require("ws");
const mqtt      = require("mqtt");
const http      = require("http");
const fs        = require("fs");
const path      = require("path");

const PORT      = process.env.PORT      || 3000;
const API_TOKEN = process.env.API_TOKEN || "dev-token-insecure";
const MQTT_HOST = process.env.MQTT_HOST || "c05498f017034c438774116639793930.s1.eu.hivemq.cloud";
const MQTT_PORT = process.env.MQTT_PORT || 8883;
const MQTT_USER = process.env.MQTT_USER || "vozilo_esp32";
const MQTT_PASS = process.env.MQTT_PASS || "VoziloEsp32!";

const TOPICS = {
  motor_lijevo      : "vozilo/motor/lijevo",
  motor_desno       : "vozilo/motor/desno",
  oba               : "vozilo/motor/oba",
  servo_skretanje   : "vozilo/servo/skretanje",
  svjetlo_duga      : "vozilo/svjetlo/duga",
  svjetlo_kratka    : "vozilo/svjetlo/kratka",
  zmigavac_lijevo   : "vozilo/svjetlo/zmigavac_lijevo",
  zmigavac_desno    : "vozilo/svjetlo/zmigavac_desno",
  stop_svjetla      : "vozilo/svjetlo/stop",
};

const TOPIC_STATUS = "vozilo/status";
const TOPIC_TEMP   = "vozilo/senzor/temperatura";

// ── HTTP SERVER ────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const filePath = path.join(__dirname, "index.html");
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("index.html not found"); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
});

// ── WEBSOCKET ──────────────────────────────────────────
const wss     = new WebSocket.Server({ server: httpServer });
const clients = new Set();

function broadcast(msg) {
  const str = JSON.stringify(msg);
  clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(str); });
}

wss.on("connection", (ws, req) => {
  const url   = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("token");

  if (token !== API_TOKEN) {
    ws.close(4001, "Unauthorized");
    console.warn("[WS] Odbijen klijent — pogrešan token.");
    return;
  }

  clients.add(ws);
  console.log(`[WS] Novi klijent. Ukupno: ${clients.size}`);

  ws.send(JSON.stringify({
    type        : "init",
    mqtt        : mqttConnected,
    vozilo      : voziloOnline,
    temperatura : zadnjaTemp,
  }));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case "motor_command": {
        const topic = TOPICS[msg.motorId];
        if (!topic || !mqttConnected) return;
        mqttClient.publish(topic, JSON.stringify({ value: msg.value }), { qos: 1 });
        break;
      }

      case "svjetlo_command": {
        const topic = TOPICS[msg.svjetloId];
        if (!topic || !mqttConnected) return;
        mqttClient.publish(topic, JSON.stringify({ value: msg.value }), { qos: 1 });
        break;
      }

      case "servo_command": {
        if (!mqttConnected) return;
        mqttClient.publish(TOPICS.servo_skretanje, JSON.stringify({ value: msg.value }), { qos: 1 });
        break;
      }

      case "emergency_stop": {
        // Zaustavi motore, servo na sredinu, sve stop
        mqttClient.publish(TOPICS.motor_lijevo,    JSON.stringify({ value: 0   }), { qos: 1 });
        mqttClient.publish(TOPICS.motor_desno,     JSON.stringify({ value: 0   }), { qos: 1 });
        mqttClient.publish(TOPICS.servo_skretanje, JSON.stringify({ value: 90  }), { qos: 1 });
        mqttClient.publish(TOPICS.svjetlo_duga,    JSON.stringify({ value: 0   }), { qos: 1 });
        mqttClient.publish(TOPICS.svjetlo_kratka,  JSON.stringify({ value: 0   }), { qos: 1 });
        mqttClient.publish(TOPICS.zmigavac_lijevo, JSON.stringify({ value: 0   }), { qos: 1 });
        mqttClient.publish(TOPICS.zmigavac_desno,  JSON.stringify({ value: 0   }), { qos: 1 });
        mqttClient.publish(TOPICS.stop_svjetla,    JSON.stringify({ value: 0   }), { qos: 1 });
        broadcast({ type: "emergency_stop" });
        console.log("[WS] ⚠ EMERGENCY STOP!");
        break;
      }

      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[WS] Klijent odspojen. Ukupno: ${clients.size}`);
  });
});

// ── MQTT ───────────────────────────────────────────────
let mqttConnected = false;
let voziloOnline  = false;
let zadnjaTemp    = null;

console.log("[MQTT] Spajanje na broker...");

const mqttClient = mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
  username          : MQTT_USER,
  password          : MQTT_PASS,
  rejectUnauthorized: false,
});

mqttClient.on("connect", () => {
  mqttConnected = true;
  console.log("[MQTT] ✓ Spojen!");
  mqttClient.subscribe(TOPIC_STATUS, { qos: 1 });
  mqttClient.subscribe(TOPIC_TEMP,   { qos: 0 });
  broadcast({ type: "mqtt_status", connected: true });
});

mqttClient.on("error",     (err) => console.error("[MQTT] Greška:", err.message));
mqttClient.on("reconnect", ()    => { mqttConnected = false; broadcast({ type: "mqtt_status", connected: false }); });

mqttClient.on("message", (topic, payload) => {
  try {
    const data = JSON.parse(payload.toString());
    if (topic === TOPIC_STATUS) {
      voziloOnline = data.status === "online";
      broadcast({ type: "vozilo_status", online: voziloOnline, data });
      console.log("[MQTT] Vozilo:", data.status);
    }
    if (topic === TOPIC_TEMP) {
      zadnjaTemp = data;
      broadcast({ type: "temperatura", temp: data.temp, hum: data.hum });
      console.log(`[MQTT] Temp: ${data.temp}°C | Vlaga: ${data.hum}%`);
    }
  } catch (e) {}
});

setInterval(() => {
  broadcast({ type: "heartbeat", vozilo: voziloOnline, mqtt: mqttConnected, temperatura: zadnjaTemp });
}, 10000);

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[SERVER] ✓ Pokrenut na portu ${PORT}`);
});

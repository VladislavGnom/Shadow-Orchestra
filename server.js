// server.js — «Теневой оркестр»
// Клиенты сами сообщают свой тип через 'register' — только так сервер
// узнаёт, кто из подключённых сокетов реально игрок (player.html),
// а не пульт/визуализация/зритель. Это чинит баг со счётчиком игроков.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = 3000;

// ───────────────────────────────────────────────
// Раздача статики из public/ + чистые пути
// ───────────────────────────────────────────────
app.use(express.static('public'));
app.get('/player', (req, res) => res.sendFile(__dirname + '/public/player.html'));
app.get('/visuals', (req, res) => res.sendFile(__dirname + '/public/visuals.html'));
app.get('/conductor', (req, res) => res.sendFile(__dirname + '/public/conductor.html'));

// ───────────────────────────────────────────────
// Глобальное состояние оркестра
// ───────────────────────────────────────────────
const orchestra = {
  bpm: 120,
  key: 'C',
  scale: 'minor',
  mode: 'ambient',
  totalPlayers: 0,   // счётчик для назначения ролей — только растёт, не уменьшается при disconnect
  instruments: {}    // socket.id -> { role, note, velocity, lastUpdate }, только ЗАРЕГИСТРИРОВАННЫЕ игроки
};

const ROLES = ['bass', 'pad', 'lead', 'arp', 'fx'];

// ───────────────────────────────────────────────
// Гаммы: генерируются для всех 7 тональностей × 3 гаммы
// Ключ объекта scales — "key:scale", например "C:minor"
// ───────────────────────────────────────────────
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const KEY_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const SCALE_INTERVALS = {
  major:      [0, 2, 4, 5, 7, 9, 11, 12],
  minor:      [0, 2, 3, 5, 7, 8, 10, 12],
  pentatonic: [0, 2, 4, 7, 9]
};

const BASE_OCTAVE = 3;
const FALLBACK_SCALE = ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5'];

function noteFromOffset(rootSemitone, offset) {
  const total = rootSemitone + offset;
  const octave = BASE_OCTAVE + Math.floor(total / 12);
  const semitoneInOctave = ((total % 12) + 12) % 12;
  return `${NOTE_NAMES[semitoneInOctave]}${octave}`;
}

const scales = {};
for (const key of Object.keys(KEY_SEMITONE)) {
  for (const scaleName of Object.keys(SCALE_INTERVALS)) {
    const intervals = SCALE_INTERVALS[scaleName];
    scales[`${key}:${scaleName}`] = intervals.map((offset) =>
      noteFromOffset(KEY_SEMITONE[key], offset)
    );
  }
}

// ───────────────────────────────────────────────
// Утилиты маппинга motion → sound
// ───────────────────────────────────────────────
function gammaToNoteIndex(gamma, scaleLength) {
  const clamped = Math.max(-90, Math.min(90, gamma));
  const normalized = (clamped + 90) / 180;
  return Math.min(scaleLength - 1, Math.floor(normalized * scaleLength));
}

function betaToVelocity(beta) {
  return Math.max(0, Math.min(1, Math.abs(beta) / 180));
}

function getCurrentScale() {
  const scaleKey = `${orchestra.key}:${orchestra.scale}`;
  return scales[scaleKey] || FALLBACK_SCALE;
}

/**
 * Сериализует orchestra.instruments в обычный объект для отправки клиентам.
 * includeLastUpdate — нужно для visualization-data, не нужно для orchestra-update.
 */
function serializeInstruments(includeLastUpdate) {
  const result = {};
  for (const id of Object.keys(orchestra.instruments)) {
    const data = orchestra.instruments[id];
    result[id] = includeLastUpdate
      ? { role: data.role, note: data.note, velocity: data.velocity, lastUpdate: data.lastUpdate }
      : { role: data.role, note: data.note, velocity: data.velocity };
  }
  return result;
}

/**
 * Считает ТОЛЬКО зарегистрированных игроков (orchestra.instruments),
 * а не все подключённые сокеты — раньше сюда попадали conductor и visuals,
 * из-за чего счётчик на пульте был завышен.
 */
function broadcastPlayerCount() {
  const activePlayers = Object.keys(orchestra.instruments).length;

  io.emit('orchestra-update', {
    players: orchestra.totalPlayers,
    activePlayers,
    instruments: serializeInstruments(false)
  });
}

// ───────────────────────────────────────────────
// Socket.IO
// ───────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[socket] ${socket.id} подключился, ждём 'register'`);

  // ── register: клиент сообщает свой тип ──────────
  socket.on('register', ({ type }) => {
    socket.clientType = type;

    if (type === 'player') {
      // Роль назначается по кругу, счётчик только растёт
      orchestra.totalPlayers += 1;
      const role = ROLES[(orchestra.totalPlayers - 1) % ROLES.length];

      orchestra.instruments[socket.id] = {
        role,
        note: null,
        velocity: 0,
        lastUpdate: null
      };

      socket.emit('init', {
        role,
        settings: {
          bpm: orchestra.bpm,
          key: orchestra.key,
          scale: orchestra.scale,
          mode: orchestra.mode
        }
      });

      console.log(`[register] ${socket.id} → player, роль "${role}" (всего игроков за сессию: ${orchestra.totalPlayers})`);
    } else {
      console.log(`[register] ${socket.id} → ${type}`);
    }

    broadcastPlayerCount();
  });

  // ── motion → sound-update (только для зарегистрированных игроков) ──
  socket.on('motion', ({ gamma, beta }) => {
    if (typeof gamma !== 'number' || typeof beta !== 'number') return;

    const instrument = orchestra.instruments[socket.id];
    if (!instrument) return; // сокет ещё не зарегистрирован как player

    const currentScale = getCurrentScale();
    const noteIndex = gammaToNoteIndex(gamma, currentScale.length);
    const note = currentScale[noteIndex];
    const velocity = betaToVelocity(beta);

    instrument.note = note;
    instrument.velocity = velocity;
    instrument.lastUpdate = Date.now();

    socket.emit('sound-update', { note, velocity });
  });

  // ── conductor-command → orchestra-settings (broadcast) ──
  socket.on('conductor-command', ({ bpm, key, scale, mode }) => {
    if (typeof bpm === 'number') {
      orchestra.bpm = Math.max(40, Math.min(200, bpm));
    }
    if (key && KEY_SEMITONE[key] !== undefined) {
      orchestra.key = key;
    }
    if (scale && SCALE_INTERVALS[scale]) {
      orchestra.scale = scale;
    }
    if (mode && ['ambient', 'beat', 'chaos'].includes(mode)) {
      orchestra.mode = mode;
    }

    io.emit('orchestra-settings', {
      bpm: orchestra.bpm,
      key: orchestra.key,
      scale: orchestra.scale,
      mode: orchestra.mode
    });
  });

  // ── disconnect: убираем из instruments, только если это был player ──
  socket.on('disconnect', () => {
    if (socket.clientType === 'player' && orchestra.instruments[socket.id]) {
      delete orchestra.instruments[socket.id];
      broadcastPlayerCount();
    }
    console.log(`[socket] ${socket.id} отключился (тип: ${socket.clientType || 'не зарегистрирован'})`);
  });
});

// ───────────────────────────────────────────────
// visualization-data каждые 33 мс, broadcast всем
// ───────────────────────────────────────────────
setInterval(() => {
  io.emit('visualization-data', {
    bpm: orchestra.bpm,
    mode: orchestra.mode,
    instruments: serializeInstruments(true)
  });
}, 33);

// ───────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`🎭 Теневой оркестр запущен: http://localhost:${PORT}`);
  console.log(`   /player     — инструмент (телефон)`);
  console.log(`   /visuals    — визуализация (проектор)`);
  console.log(`   /conductor  — пульт дирижёра`);
});

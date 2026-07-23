// server.js — «Теневой оркестр»
// Два режима исполнения (playMode): 'synth' (инструменты) и 'remix' (пульт эффектов).
// ВАЖНО: playMode — это НЕ то же самое, что mode (ambient/beat/chaos, визуальный режим).
// Это две независимые оси состояния, см. пояснение в ответе.

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e8 // спектр/служебные сообщения — маленькие, но оставляем запас
});

const PORT = 3000;

// ───────────────────────────────────────────────
// Раздача статики + чистые пути
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
  mode: 'ambient',      // ambient | beat | chaos — визуальный/сценический режим (существовал раньше)
  playMode: 'synth',    // synth | remix — инструменты vs пульт эффектов
  totalPlayers: 0,      // счётчик для назначения ролей — только растёт
  instruments: {}       // socket.id -> { role, playMode, joinIndex, note, velocity, value, lastUpdate }
};

const SYNTH_ROLES = ['bass', 'pad', 'lead', 'arp', 'fx'];
const REMIX_ROLES = ['filter', 'reverb', 'delay', 'pitch', 'distortion'];

function rolesForPlayMode(playMode) {
  return playMode === 'remix' ? REMIX_ROLES : SYNTH_ROLES;
}

// Сокеты, зарегистрированные как хост (conductor.html) — им ретранслируем effect-change
const conductorSocketIds = new Set();

// ───────────────────────────────────────────────
// Гаммы (для playMode = synth), как раньше
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
    scales[`${key}:${scaleName}`] = intervals.map((offset) => noteFromOffset(KEY_SEMITONE[key], offset));
  }
}

function gammaToNoteIndex(gamma, scaleLength) {
  const clamped = Math.max(-90, Math.min(90, gamma));
  const normalized = (clamped + 90) / 180;
  return Math.min(scaleLength - 1, Math.floor(normalized * scaleLength));
}

function betaToVelocity(beta) {
  return Math.max(0, Math.min(1, Math.abs(beta) / 180));
}

function getCurrentScale() {
  return scales[`${orchestra.key}:${orchestra.scale}`] || FALLBACK_SCALE;
}

// ───────────────────────────────────────────────
// Сериализация instruments для клиентов
// ───────────────────────────────────────────────
function serializeInstruments(includeLastUpdate) {
  const result = {};
  for (const id of Object.keys(orchestra.instruments)) {
    const data = orchestra.instruments[id];
    result[id] = includeLastUpdate
      ? { role: data.role, playMode: data.playMode, note: data.note, velocity: data.velocity, value: data.value, lastUpdate: data.lastUpdate }
      : { role: data.role, playMode: data.playMode, note: data.note, velocity: data.velocity, value: data.value };
  }
  return result;
}

function broadcastPlayerCount() {
  io.emit('orchestra-update', {
    players: orchestra.totalPlayers,
    activePlayers: Object.keys(orchestra.instruments).length,
    instruments: serializeInstruments(false)
  });
}

function currentSettingsPayload() {
  return {
    bpm: orchestra.bpm,
    key: orchestra.key,
    scale: orchestra.scale,
    mode: orchestra.mode,
    playMode: orchestra.playMode
  };
}

/**
 * Переназначает роли ВСЕМ подключённым игрокам под текущий orchestra.playMode
 * и рассылает каждому персональный 'init'. Вызывается при смене playMode.
 */
function reassignAllRoles() {
  const roles = rolesForPlayMode(orchestra.playMode);

  for (const id of Object.keys(orchestra.instruments)) {
    const instrument = orchestra.instruments[id];
    const role = roles[(instrument.joinIndex - 1) % roles.length];

    instrument.role = role;
    instrument.playMode = orchestra.playMode;
    instrument.note = null;
    instrument.velocity = 0;
    instrument.value = null;
    instrument.lastUpdate = null;

    const targetSocket = io.sockets.sockets.get(id);
    if (targetSocket) {
      targetSocket.emit('init', { role, settings: currentSettingsPayload() });
    }
  }
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
      orchestra.totalPlayers += 1;
      const joinIndex = orchestra.totalPlayers;
      const roles = rolesForPlayMode(orchestra.playMode);
      const role = roles[(joinIndex - 1) % roles.length];

      orchestra.instruments[socket.id] = {
        role,
        playMode: orchestra.playMode,
        joinIndex,
        note: null,
        velocity: 0,
        value: null,
        lastUpdate: null
      };

      socket.emit('init', { role, settings: currentSettingsPayload() });
      console.log(`[register] ${socket.id} → player, роль "${role}" (playMode: ${orchestra.playMode})`);
    } else if (type === 'conductor') {
      conductorSocketIds.add(socket.id);
      console.log(`[register] ${socket.id} → conductor`);
    } else {
      console.log(`[register] ${socket.id} → ${type}`);
    }

    broadcastPlayerCount();
  });

  // ── motion: используется ТОЛЬКО в playMode = synth. ──
  // В remix-режиме player.html сам считает значение эффекта и шлёт effect-change,
  // без обращения к серверу за маппингом — см. player.html.
  socket.on('motion', ({ gamma, beta }) => {
    if (typeof gamma !== 'number' || typeof beta !== 'number') return;

    const instrument = orchestra.instruments[socket.id];
    if (!instrument || instrument.playMode !== 'synth') return;

    const currentScale = getCurrentScale();
    const noteIndex = gammaToNoteIndex(gamma, currentScale.length);
    const note = currentScale[noteIndex];
    const velocity = betaToVelocity(beta);

    instrument.note = note;
    instrument.velocity = velocity;
    instrument.lastUpdate = Date.now();

    socket.emit('sound-update', { note, velocity });
  });

  // ── effect-change: используется ТОЛЬКО в playMode = remix ──
  // Ретранслируется на всех зарегистрированных хостов (conductor.html)
  socket.on('effect-change', ({ role, value }) => {
    const instrument = orchestra.instruments[socket.id];
    if (!instrument || instrument.playMode !== 'remix') return;
    if (typeof value !== 'number') return;

    instrument.value = value;
    instrument.lastUpdate = Date.now();

    for (const conductorId of conductorSocketIds) {
      const conductorSocket = io.sockets.sockets.get(conductorId);
      if (conductorSocket) {
        conductorSocket.emit('effect-change', { role, value, playerId: socket.id });
      }
    }
  });

  // ── conductor-command: bpm/key/scale/mode/playMode ──
  socket.on('conductor-command', ({ bpm, key, scale, mode, playMode }) => {
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

    const playModeChanged = playMode && ['synth', 'remix'].includes(playMode) && playMode !== orchestra.playMode;
    if (playModeChanged) {
      orchestra.playMode = playMode;
      reassignAllRoles(); // рассылает персональные 'init' всем игрокам
      console.log(`[conductor-command] playMode → ${playMode}, роли переназначены`);
    }

    io.emit('orchestra-settings', currentSettingsPayload());

    if (playModeChanged) {
      broadcastPlayerCount(); // instruments поменялись (role/value/note сброшены)
    }
  });

  // ── spectrum-data: хост шлёт FFT-бины для визуализации в remix-режиме ──
  socket.on('spectrum-data', (data) => {
    if (socket.clientType !== 'conductor') return;
    io.emit('spectrum-data', data);
  });

  // ── load-preloaded-track: хост просит поднять трек из public/tracks/ ──
  // Файл уже лежит на диске (загруженный через /upload-track, либо предзагруженный
  // вручную) — просто отдаём его URL, ничего не читаем в память целиком.
  socket.on('load-preloaded-track', ({ filename }) => {
    if (socket.clientType !== 'conductor') return;

    const safeName = path.basename(String(filename || '')); // защита от path traversal
    const filePath = path.join(TRACKS_DIR, safeName);

    fs.access(filePath, fs.constants.R_OK, (err) => {
      if (err) {
        socket.emit('track-load-error', { message: `Не удалось загрузить трек: ${safeName}` });
        return;
      }
      io.emit('track-loaded', { name: safeName, url: `/tracks/${safeName}` });
    });
  });

  // ── disconnect ──────────────────────────────────
  socket.on('disconnect', () => {
    conductorSocketIds.delete(socket.id);

    if (socket.clientType === 'player' && orchestra.instruments[socket.id]) {
      delete orchestra.instruments[socket.id];
      broadcastPlayerCount();
    }
    console.log(`[socket] ${socket.id} отключился (тип: ${socket.clientType || 'не зарегистрирован'})`);
  });
});

// ───────────────────────────────────────────────
// visualization-data каждые 33 мс, broadcast всем (для playMode = synth)
// ───────────────────────────────────────────────
setInterval(() => {
  io.emit('visualization-data', {
    bpm: orchestra.bpm,
    mode: orchestra.mode,
    playMode: orchestra.playMode,
    instruments: serializeInstruments(true)
  });
}, 33);

// ───────────────────────────────────────────────
// Загрузка треков: multer → диск (public/tracks/) → URL.
//
// ИЗМЕНЕНО: раньше файл шёл в memoryStorage → base64 → io.emit всем клиентам
// через WebSocket. Трек 3-4 МБ в base64 ≈ 5 МБ текста — на телефоне POST-запрос
// обрывался по таймауту ("Request aborted") ещё до того, как multer успевал
// его дочитать. Теперь multer сразу пишет поток на диск (без буферизации в
// памяти), сервер отвечает мгновенно, а клиенты получают короткий URL и грузят
// аудио через обычный HTTP GET (его отдаёт express.static('public') — папка
// tracks/ уже статическая).
// ───────────────────────────────────────────────
const TRACKS_DIR = path.join(__dirname, 'public', 'tracks');
if (!fs.existsSync(TRACKS_DIR)) {
  fs.mkdirSync(TRACKS_DIR, { recursive: true });
}

const ALLOWED_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a'];

const trackStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TRACKS_DIR),
  filename: (req, file, cb) => {
    // Убираем всё, что не буквы/цифры/точка/дефис/подчёркивание, и добавляем
    // временную метку спереди, чтобы не затирать одноимённые файлы разных загрузок.
    const safeOriginal = path.basename(file.originalname).replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `${Date.now()}-${safeOriginal}`);
  }
});

const upload = multer({
  storage: trackStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 МБ — этого хватает на 2-3 минуты mp3 в приличном качестве
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(new Error('Неподдерживаемый формат файла: ' + ext));
    }
    cb(null, true);
  }
});

// Загрузка обёрнута вручную (не как обычный middleware в цепочке app.post),
// чтобы поймать ошибки multer явно — включая "Request aborted", когда клиент
// (медленный тоннель/телефон/закрытая вкладка) обрывает запрос на середине.
// Без этого такие ошибки долетают до дефолтного Express-обработчика и
// печатаются как голый стектрейс в консоль, а conductor.html зависает
// на "Загружаю файл..." без внятного ответа.
app.post('/upload-track', (req, res) => {
  upload.single('track')(req, res, (err) => {
    if (err) {
      console.warn('[upload-track] загрузка прервана или отклонена:', err.message);
      if (!res.headersSent) {
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        res.status(status).json({ error: 'Ошибка загрузки файла: ' + err.message });
      }
      return;
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Файл не получен (поле формы должно называться "track")' });
    }

    const url = `/tracks/${req.file.filename}`;

    res.json({ ok: true, name: req.file.originalname, url });

    io.emit('track-loaded', { name: req.file.originalname, url });
  });
});

// GET /api/tracks — список предзагруженных треков из public/tracks/
app.get('/api/tracks', (req, res) => {
  fs.readdir(TRACKS_DIR, (err, files) => {
    if (err) {
      return res.json({ tracks: [] });
    }
    const audioFiles = files.filter((f) => /\.(mp3|wav|ogg|m4a)$/i.test(f));
    res.json({ tracks: audioFiles });
  });
});

// Общий error-handler Express — подстраховка на случай, если ошибка всё же
// всплывёт откуда-то ещё (не только из /upload-track). Должен идти последним.
app.use((err, req, res, next) => {
  console.error('[express] необработанная ошибка запроса:', err.message);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ───────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`🎭 Теневой оркестр запущен: http://localhost:${PORT}`);
  console.log(`   /player     — инструмент / пульт эффектов (телефон)`);
  console.log(`   /visuals    — визуализация (проектор)`);
  console.log(`   /conductor  — пульт дирижёра + хост-плеер`);
});
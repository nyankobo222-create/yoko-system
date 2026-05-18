const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---- State ----

let state = {
  phase: 'lobby',
  questionNumber: 0,
  questionStartTime: null,
  questionDuration: 30,
  correctAnswer: null,
};

let players = {};
// socketId -> { name, score, currentAnswer, currentAnswerTime, answers[] }

let audience = {};
// socketId -> { name, score, currentPick, currentPickTime, answers[] }

// 離脱後120秒間データを保持して復帰に備える
let savedPlayers = {};  // name -> { score, answers, timer }
let savedAudience = {}; // name -> { score, answers, timer }
const REJOIN_TTL = 120_000;

// ---- Helpers ----

function calcPoints(responseMs, durationSec, isCorrect) {
  if (!isCorrect) return 0;
  const ratio = Math.min(1, responseMs / (durationSec * 1000));
  return Math.round(500 + 500 * (1 - ratio));
}

function getLiveStats() {
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  const responded = [];
  Object.values(players).forEach(p => {
    if (p.currentAnswer) {
      counts[p.currentAnswer]++;
      responded.push({ name: p.name, time: p.currentAnswerTime });
    }
  });
  responded.sort((a, b) => a.time - b.time);
  return {
    counts,
    responded,
    total: responded.length,
    playerCount: Object.keys(players).length,
  };
}

function getRanking() {
  return Object.values(players)
    .map(p => ({ name: p.name, score: p.score, answers: p.answers }))
    .sort((a, b) => b.score - a.score);
}

function getRepList() {
  return Object.values(players).map(p => p.name);
}

function getAudienceRanking() {
  return Object.values(audience)
    .map(a => ({ name: a.name, score: a.score, answers: a.answers }))
    .sort((a, b) => b.score - a.score);
}

function getAudiencePickStats() {
  const counts = {};
  Object.values(audience).forEach(a => {
    if (a.currentPick) counts[a.currentPick] = (counts[a.currentPick] || 0) + 1;
  });
  return {
    counts,
    total: Object.values(audience).filter(a => a.currentPick).length,
    audienceCount: Object.keys(audience).length,
  };
}

// ---- QR endpoint ----

app.get('/qr', async (req, res) => {
  try {
    const url = req.query.url || `${req.protocol}://${req.get('host')}/`;
    const dataUrl = await QRCode.toDataURL(url, { width: 280, margin: 2 });
    res.json({ dataUrl, url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Socket.io ----

io.on('connection', (socket) => {

  // === REPRESENTATIVE ===

  socket.on('player:join', (name) => {
    if (!name || typeof name !== 'string') return;
    const trimmed = name.trim().slice(0, 20);
    if (!trimmed) return;
    // 保存データがあれば復元
    const saved = savedPlayers[trimmed];
    if (saved) {
      clearTimeout(saved.timer);
      delete savedPlayers[trimmed];
    }
    players[socket.id] = {
      name: trimmed,
      score: saved?.score ?? 0,
      currentAnswer: null,
      currentAnswerTime: null,
      answers: saved?.answers ?? [],
    };
    socket.emit('player:joined', { name: trimmed, state });
    io.emit('player:count', Object.keys(players).length);
    io.to('admin').emit('admin:players', getRanking());
    io.to('audience').emit('rep:list', getRepList());
  });

  socket.on('player:answer', (choice) => {
    const p = players[socket.id];
    if (!p || state.phase !== 'question' || p.currentAnswer) return;
    if (!['A', 'B', 'C', 'D'].includes(choice)) return;

    const responseMs = Date.now() - state.questionStartTime;
    p.currentAnswer = choice;
    p.currentAnswerTime = responseMs;

    socket.emit('player:answer_ok', { choice, time: responseMs });
    io.emit('stats:live', getLiveStats());
    io.to('admin').emit('admin:players', getRanking());
  });

  // === AUDIENCE ===

  socket.on('audience:join', (name) => {
    if (!name || typeof name !== 'string') return;
    const trimmed = name.trim().slice(0, 20);
    if (!trimmed) return;
    const saved = savedAudience[trimmed];
    if (saved) {
      clearTimeout(saved.timer);
      delete savedAudience[trimmed];
    }
    audience[socket.id] = {
      name: trimmed,
      score: saved?.score ?? 0,
      currentPick: null,
      currentPickTime: null,
      answers: saved?.answers ?? [],
    };
    socket.join('audience');
    socket.emit('audience:joined', { name: trimmed, state, repList: getRepList() });
    io.to('admin').emit('admin:audience', getAudienceRanking());
    io.to('admin').emit('admin:audience_count', Object.keys(audience).length);
  });

  socket.on('audience:pick', (repName) => {
    const a = audience[socket.id];
    if (!a || state.phase !== 'question' || a.currentPick) return;
    if (!getRepList().includes(repName)) return;

    const responseMs = Date.now() - state.questionStartTime;
    a.currentPick = repName;
    a.currentPickTime = responseMs;

    socket.emit('audience:pick_ok', { pick: repName, time: responseMs });
    io.emit('audience:pick_stats', getAudiencePickStats());
  });

  // === SCREEN ===

  socket.on('screen:join', () => {
    socket.join('screen');
    socket.emit('game:state', state);
    socket.emit('stats:live', getLiveStats());
    socket.emit('player:count', Object.keys(players).length);
  });

  // === ADMIN ===

  socket.on('admin:join', () => {
    socket.join('admin');
    socket.emit('admin:init', {
      state,
      players: getRanking(),
      audience: getAudienceRanking(),
      audienceCount: Object.keys(audience).length,
    });
  });

  socket.on('admin:start_question', ({ questionNumber, duration, isTest }) => {
    Object.values(players).forEach(p => {
      p.currentAnswer = null;
      p.currentAnswerTime = null;
    });
    Object.values(audience).forEach(a => {
      a.currentPick = null;
      a.currentPickTime = null;
    });
    state = {
      phase: 'question',
      questionNumber: questionNumber,
      questionStartTime: Date.now(),
      questionDuration: duration || 30,
      correctAnswer: null,
      isTest: !!isTest,
    };
    io.emit('game:state', state);
    io.emit('stats:live', getLiveStats());
    io.emit('audience:pick_stats', { counts: {}, total: 0, audienceCount: Object.keys(audience).length });
    io.to('audience').emit('rep:list', getRepList());
  });

  socket.on('admin:reveal', (correctAnswer) => {
    if (!['A', 'B', 'C', 'D'].includes(correctAnswer)) return;
    state.phase = 'revealed';
    state.correctAnswer = correctAnswer;

    // Score representatives
    Object.values(players).forEach(p => {
      const isCorrect = p.currentAnswer === correctAnswer;
      const pts = state.isTest ? 0 : calcPoints(p.currentAnswerTime, state.questionDuration, isCorrect);
      p.score += pts;
      if (!state.isTest) {
        p.answers.push({
          q: state.questionNumber,
          choice: p.currentAnswer,
          correct: isCorrect,
          pts,
          time: p.currentAnswerTime,
        });
      }
    });

    // Determine which reps answered correctly
    const correctReps = Object.values(players)
      .filter(p => p.currentAnswer === correctAnswer)
      .map(p => p.name);

    // Score audience
    Object.values(audience).forEach(a => {
      const isCorrect = a.currentPick !== null && correctReps.includes(a.currentPick);
      const pts = state.isTest ? 0 : calcPoints(a.currentPickTime, state.questionDuration, isCorrect);
      a.score += pts;
      if (!state.isTest) {
        a.answers.push({
          q: state.questionNumber,
          pick: a.currentPick,
          correct: isCorrect,
          pts,
          time: a.currentPickTime,
        });
      }
    });

    const stats = getLiveStats();
    const ranking = getRanking();
    const audienceRanking = getAudienceRanking();
    const audiencePickStats = getAudiencePickStats();

    io.emit('game:state', state);
    io.emit('game:revealed', { correctAnswer, stats, ranking, correctReps, audienceRanking, audiencePickStats });
    io.to('admin').emit('admin:players', ranking);
    io.to('admin').emit('admin:audience', audienceRanking);
  });

  socket.on('admin:finish', () => {
    state.phase = 'finished';
    io.emit('game:state', state);
    io.emit('game:finished', { repRanking: getRanking(), audienceRanking: getAudienceRanking() });
  });

  socket.on('admin:reset', () => {
    players = {};
    audience = {};
    state = {
      phase: 'lobby',
      questionNumber: 0,
      questionStartTime: null,
      questionDuration: 30,
      correctAnswer: null,
    };
    io.emit('game:state', state);
    io.emit('player:count', 0);
    io.to('admin').emit('admin:players', []);
    io.to('admin').emit('admin:audience', []);
    io.to('admin').emit('admin:audience_count', 0);
  });

  // === DISCONNECT ===

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      const p = players[socket.id];
      // 120秒間データ保持（復帰できるようにする）
      savedPlayers[p.name] = {
        score: p.score,
        answers: p.answers,
        timer: setTimeout(() => delete savedPlayers[p.name], REJOIN_TTL),
      };
      delete players[socket.id];
      io.emit('player:count', Object.keys(players).length);
      io.to('admin').emit('admin:players', getRanking());
      io.to('audience').emit('rep:list', getRepList());
    }
    if (audience[socket.id]) {
      const a = audience[socket.id];
      savedAudience[a.name] = {
        score: a.score,
        answers: a.answers,
        timer: setTimeout(() => delete savedAudience[a.name], REJOIN_TTL),
      };
      delete audience[socket.id];
      io.to('admin').emit('admin:audience', getAudienceRanking());
      io.to('admin').emit('admin:audience_count', Object.keys(audience).length);
    }
  });

});

// ---- Start ----

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n====================================');
  console.log('  🎯  余興クイズシステム  起動しました');
  console.log('====================================');
  console.log(`  参加者URL : http://localhost:${PORT}/`);
  console.log(`  スクリーン: http://localhost:${PORT}/screen.html`);
  console.log(`  管理者    : http://localhost:${PORT}/admin.html`);
  console.log('====================================\n');
});

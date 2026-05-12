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
  phase: 'lobby', // lobby | question | revealed | finished
  questionNumber: 0,
  questionStartTime: null,
  questionDuration: 30,
  correctAnswer: null,
};

let players = {};
// socketId -> { name, score, currentAnswer, currentAnswerTime, answers[] }

// ---- Helpers ----

function calcPoints(responseMs, durationSec, isCorrect) {
  if (!isCorrect) return 0;
  const ratio = Math.min(1, responseMs / (durationSec * 1000));
  return Math.round(500 + 500 * (1 - ratio)); // 500〜1000pt
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

  // === PARTICIPANT ===

  socket.on('player:join', (name) => {
    if (!name || typeof name !== 'string') return;
    const trimmed = name.trim().slice(0, 20);
    if (!trimmed) return;
    players[socket.id] = {
      name: trimmed,
      score: 0,
      currentAnswer: null,
      currentAnswerTime: null,
      answers: [],
    };
    socket.emit('player:joined', { name: trimmed, state });
    io.emit('player:count', Object.keys(players).length);
    io.to('admin').emit('admin:players', getRanking());
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
    socket.emit('admin:init', { state, players: getRanking() });
  });

  socket.on('admin:start_question', ({ questionNumber, duration, isTest }) => {
    Object.values(players).forEach(p => {
      p.currentAnswer = null;
      p.currentAnswerTime = null;
    });
    state = {
      phase: 'question',
      questionNumber: questionNumber || 1,
      questionStartTime: Date.now(),
      questionDuration: duration || 30,
      correctAnswer: null,
      isTest: !!isTest,
    };
    io.emit('game:state', state);
    io.emit('stats:live', getLiveStats());
  });

  socket.on('admin:reveal', (correctAnswer) => {
    if (!['A', 'B', 'C', 'D'].includes(correctAnswer)) return;
    state.phase = 'revealed';
    state.correctAnswer = correctAnswer;

    Object.values(players).forEach(p => {
      const isCorrect = p.currentAnswer === correctAnswer;
      // テスト問題はスコアに加算しない
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

    const stats = getLiveStats();
    const ranking = getRanking();
    io.emit('game:state', state);
    io.emit('game:revealed', { correctAnswer, stats, ranking });
    io.to('admin').emit('admin:players', ranking);
  });

  socket.on('admin:finish', () => {
    state.phase = 'finished';
    io.emit('game:state', state);
    io.emit('game:finished', getRanking());
  });

  socket.on('admin:reset', () => {
    players = {};
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
  });

  // === DISCONNECT ===

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      delete players[socket.id];
      io.emit('player:count', Object.keys(players).length);
      io.to('admin').emit('admin:players', getRanking());
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

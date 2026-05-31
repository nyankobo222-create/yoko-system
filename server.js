const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'jcadmin2026';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- State ----

let state = {
  phase: 'lobby',
  questionNumber: 0,
  questionStartTime: null,
  questionDuration: 30,
  correctAnswer: null,
  questionText: '',
  choices: { A: '', B: '', C: '', D: '' },
};

let players = {};
// socketId -> { name, score, currentAnswer, currentAnswerTime, answers[] }

let audience = {};
// socketId -> { name, score, currentPick, currentPickTime, answers[] }

let savedPlayers = {};
let savedAudience = {};
const REJOIN_TTL = 120_000;

let audienceScoring = { correctPts: 300, wrongPts: -100 };

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
    a.currentPick.forEach(r => {
      counts[r] = (counts[r] || 0) + 1;
    });
  });
  return {
    counts,
    total: Object.values(audience).filter(a => a.currentPick.length > 0).length,
    audienceCount: Object.keys(audience).length,
  };
}

// ---- Ranking Reveal ----

let revealData = { active: false, ranking: [], index: 0, group: 'rep', label: '' };

function getRevealInfo() {
  return {
    active: revealData.active,
    index: revealData.index,
    total: revealData.ranking.length,
    next: revealData.ranking[revealData.index] || null,
    nextRank: revealData.ranking.length - revealData.index,
    group: revealData.group,
    label: revealData.label,
  };
}

// ---- Admin auth ----

app.post('/admin-auth', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false });
  }
});

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
      currentPick: [],
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
    if (!a || state.phase !== 'preview') return;
    if (!getRepList().includes(repName)) return;

    const idx = a.currentPick.indexOf(repName);
    if (idx >= 0) {
      a.currentPick.splice(idx, 1);
    } else {
      a.currentPick.push(repName);
      if (!a.currentPickTime) {
        a.currentPickTime = state.questionStartTime ? Date.now() - state.questionStartTime : 0;
      }
    }

    socket.emit('audience:pick_ok', { picks: [...a.currentPick], time: a.currentPickTime });
    io.emit('audience:pick_stats', getAudiencePickStats());
  });

  // === SCREEN ===

  socket.on('screen:join', () => {
    socket.join('screen');
    socket.emit('game:state', state);
    socket.emit('stats:live', getLiveStats());
    socket.emit('player:count', Object.keys(players).length);
  });

  // === RULES ===

  socket.on('admin:show_rules', (text) => {
    io.emit('screen:rules', { show: true, text: typeof text === 'string' ? text : '' });
  });

  socket.on('admin:hide_rules', () => {
    io.emit('screen:rules', { show: false, text: '' });
  });

  socket.on('admin:inject_test_data', () => {
    const repNames = ['田中太郎','鈴木花子','佐藤一郎','山田次郎','伊藤三郎','渡辺四郎','中村五郎','小林六子'];
    const repScores = [8200, 6500, 5900, 4300, 3800, 2700, 1500, 800];
    players = {};
    repNames.forEach((name, i) => {
      players['test_rep_' + i] = { name, score: repScores[i], currentAnswer: null, currentAnswerTime: null, answers: [] };
    });

    const audNames = ['青木あおい','木村きみこ','石田いしお','林はやし','松本まつこ','井上いのうえ','清水しみず','山口やまぐち','西村にしむら','河野こうの'];
    const audScores = [7400, 6100, 5300, 4800, 3600, 2900, 2100, 1600, 1000, 400];
    audience = {};
    audNames.forEach((name, i) => {
      audience['test_aud_' + i] = { name, score: audScores[i], currentPick: [], currentPickTime: null, answers: [] };
    });

    io.emit('player:count', Object.keys(players).length);
    io.to('admin').emit('admin:players', getRanking());
    io.to('admin').emit('admin:audience', getAudienceRanking());
    io.to('admin').emit('admin:audience_count', Object.keys(audience).length);
  });

  socket.on('admin:ranking_start', ({ group, label } = {}) => {
    const full = group === 'audience' ? getAudienceRanking() : getRanking();
    if (!full.length) return;
    revealData = { active: true, ranking: [...full].reverse(), index: 0, group: group || 'rep', label: label || '' };
    io.emit('ranking:start', { total: revealData.ranking.length, group: revealData.group, label: revealData.label });
    io.to('admin').emit('admin:reveal_state', getRevealInfo());
  });

  socket.on('admin:ranking_next', () => {
    if (!revealData.active || revealData.index >= revealData.ranking.length) return;
    const player = revealData.ranking[revealData.index];
    const rank = revealData.ranking.length - revealData.index;
    revealData.index++;
    io.emit('ranking:show_player', { player, rank, total: revealData.ranking.length });
    io.to('admin').emit('admin:reveal_state', getRevealInfo());
  });

  socket.on('admin:ranking_end', () => {
    revealData.active = false;
    io.emit('ranking:end');
    io.to('admin').emit('admin:reveal_state', getRevealInfo());
  });

  // === ADMIN ===

  socket.on('admin:set_audience_scoring', ({ correctPts, wrongPts }) => {
    if (typeof correctPts === 'number') audienceScoring.correctPts = correctPts;
    if (typeof wrongPts  === 'number') audienceScoring.wrongPts  = wrongPts;
  });

  socket.on('admin:join', () => {
    socket.join('admin');
    socket.emit('admin:init', {
      state,
      players: getRanking(),
      audience: getAudienceRanking(),
      audienceCount: Object.keys(audience).length,
      audienceScoring: { ...audienceScoring },
    });
  });

  socket.on('admin:preview_question', ({ questionNumber, duration, questionText, choices }) => {
    Object.values(players).forEach(p => { p.currentAnswer = null; p.currentAnswerTime = null; });
    Object.values(audience).forEach(a => { a.currentPick = []; a.currentPickTime = null; });
    state = {
      phase: 'preview',
      questionNumber,
      questionStartTime: null,
      questionDuration: duration || 30,
      correctAnswer: null,
      isTest: false,
      questionText: questionText || '',
      choices: choices || { A: '', B: '', C: '', D: '' },
    };
    io.emit('game:state', state);
    io.emit('audience:pick_stats', { counts: {}, total: 0, audienceCount: Object.keys(audience).length });
    io.to('audience').emit('rep:list', getRepList());
  });

  socket.on('admin:start_countdown', () => {
    if (state.phase !== 'preview') return;
    io.emit('game:countdown');
    setTimeout(() => {
      state.phase = 'question';
      state.questionStartTime = Date.now();
      io.emit('game:state', state);
      io.emit('stats:live', getLiveStats());
    }, 3000);
  });

  socket.on('admin:start_question', ({ questionNumber, duration, isTest, questionText, choices }) => {
    Object.values(players).forEach(p => {
      p.currentAnswer = null;
      p.currentAnswerTime = null;
    });
    Object.values(audience).forEach(a => {
      a.currentPick = [];
      a.currentPickTime = null;
    });
    state = {
      phase: 'question',
      questionNumber: questionNumber,
      questionStartTime: Date.now(),
      questionDuration: duration || 30,
      correctAnswer: null,
      isTest: !!isTest,
      questionText: questionText || '',
      choices: choices || { A: '', B: '', C: '', D: '' },
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

    const correctReps = Object.values(players)
      .filter(p => p.currentAnswer === correctAnswer)
      .map(p => p.name);

    const correctRespondents = Object.values(players)
      .filter(p => p.currentAnswer === correctAnswer)
      .map(p => ({ name: p.name, time: p.currentAnswerTime }))
      .sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));

    Object.values(audience).forEach(a => {
      const correctCount = a.currentPick.filter(r => correctReps.includes(r)).length;
      const wrongCount   = a.currentPick.filter(r => !correctReps.includes(r)).length;
      const rawPts = correctCount * audienceScoring.correctPts + wrongCount * audienceScoring.wrongPts;
      const pts = state.isTest ? 0 : Math.max(0, rawPts);
      a.score += pts;
      if (!state.isTest) {
        a.answers.push({
          q: state.questionNumber,
          picks: [...a.currentPick],
          correct: correctCount > 0,
          correctCount,
          wrongCount,
          pts,
        });
      }
    });

    const stats = getLiveStats();
    const ranking = getRanking();
    const audienceRanking = getAudienceRanking();
    const audiencePickStats = getAudiencePickStats();

    io.emit('game:state', state);
    io.emit('game:revealed', { correctAnswer, stats, ranking, correctReps, correctRespondents, audienceRanking, audiencePickStats, audienceScoring: { ...audienceScoring } });
    io.to('admin').emit('admin:players', ranking);
    io.to('admin').emit('admin:audience', audienceRanking);
  });

  socket.on('admin:finish', () => {
    state.phase = 'finished';
    io.emit('game:state', state);
    io.emit('game:finished', { repRanking: getRanking(), audienceRanking: getAudienceRanking() });
  });

  socket.on('admin:kick', ({ name, group } = {}) => {
    if (!name || typeof name !== 'string') return;
    if (group === 'audience') {
      if (savedAudience[name]) { clearTimeout(savedAudience[name].timer); delete savedAudience[name]; }
      const entry = Object.entries(audience).find(([, a]) => a.name === name);
      if (entry) {
        const [sid] = entry;
        io.to(sid).emit('player:kicked');
        delete audience[sid];
        io.to('admin').emit('admin:audience', getAudienceRanking());
        io.to('admin').emit('admin:audience_count', Object.keys(audience).length);
      }
    } else {
      if (savedPlayers[name]) { clearTimeout(savedPlayers[name].timer); delete savedPlayers[name]; }
      const entry = Object.entries(players).find(([, p]) => p.name === name);
      if (entry) {
        const [sid] = entry;
        io.to(sid).emit('player:kicked');
        delete players[sid];
        io.emit('player:count', Object.keys(players).length);
        io.to('admin').emit('admin:players', getRanking());
        io.to('audience').emit('rep:list', getRepList());
      }
    }
  });

  socket.on('admin:reset', () => {
    players = {};
    audience = {};
    audienceScoring = { correctPts: 300, wrongPts: -100 };
    revealData = { active: false, ranking: [], index: 0, group: 'rep', label: '' };
    state = {
      phase: 'lobby',
      questionNumber: 0,
      questionStartTime: null,
      questionDuration: 30,
      correctAnswer: null,
      questionText: '',
      choices: { A: '', B: '', C: '', D: '' },
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

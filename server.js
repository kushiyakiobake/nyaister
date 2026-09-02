const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
const BOARD_SIZE = 6;
const P1_TARGET_CORNERS = ['0,0', '0,5'];
const P2_TARGET_CORNERS = ['5,0', '5,5'];

// ルームごとのゲーム状態を管理
const rooms = {};

function createGameState() {
  return {
    board: Array(6).fill(null).map(() => Array(6).fill(null)),
    turn: 'p1', // 'p1' または 'p2'
    phase: 'setup', // 'setup' (初期配置中) または 'playing' (対戦中) または 'ended'
    players: {
      p1: { id: null, ready: false, setup: null }, // setup: Boolean[8]
      p2: { id: null, ready: false, setup: null }
    },
    exiled: {
      p1: { catcher: 0, nonCatcher: 0 }, // p1が追い出した相手の猫
      p2: { catcher: 0, nonCatcher: 0 }  // p2が追い出した相手の猫
    },
    winner: null,
    winReason: ''
  };
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let playerRole = 'spectator'; // 'p1', 'p2', または 'spectator'

  // ルーム参加処理
  socket.on('join_room', (roomId) => {
    currentRoom = roomId || 'default';
    socket.join(currentRoom);

    if (!rooms[currentRoom]) {
      rooms[currentRoom] = createGameState();
    }

    const state = rooms[currentRoom];

    // 役割の割り当て (P1 -> P2 -> 観戦者)
    if (!state.players.p1.id) {
      state.players.p1.id = socket.id;
      playerRole = 'p1';
    } else if (!state.players.p2.id) {
      state.players.p2.id = socket.id;
      playerRole = 'p2';
    } else {
      playerRole = 'spectator';
    }

    // 役割通知
    socket.emit('role_assigned', { role: playerRole });

    // 全員に現在の個別ビューを送信
    broadcastState(currentRoom);
  });

  // 初期配置の送信 (配置フェーズ)
  socket.on('submit_setup', (setupArray) => {
    if (!currentRoom || (playerRole !== 'p1' && playerRole !== 'p2')) return;
    const state = rooms[currentRoom];
    if (state.phase !== 'setup') return;

    // setupArray は 8要素の boolean 配列 (true: 捕る猫, false: 捕らない猫)
    if (!Array.isArray(setupArray) || setupArray.length !== 8) return;
    const catcherCount = setupArray.filter(v => v === true).length;
    if (catcherCount !== 4) return; // 捕る猫は4匹必須

    state.players[playerRole].setup = setupArray;
    state.players[playerRole].ready = true;

    // 双方の準備が完了したらゲーム開始
    if (state.players.p1.ready && state.players.p2.ready) {
      applySetupToBoard(state);
      state.phase = 'playing';
    }

    broadcastState(currentRoom);
  });

  // 駒の移動
  socket.on('move_piece', ({ from, to }) => {
    if (!currentRoom || playerRole !== stateTurn(currentRoom)) return;
    const state = rooms[currentRoom];
    if (state.phase !== 'playing') return;

    const [fromR, fromC] = [from.r, from.c];
    const [toR, toC] = [to.r, to.c];

    const piece = state.board[fromR][fromC];
    if (!piece || piece.owner !== playerRole) return;

    // 移動の妥当性検証
    const dr = Math.abs(fromR - toR);
    const dc = Math.abs(fromC - toC);
    if (!((dr === 1 && dc === 0) || (dr === 0 && dc === 1))) return;

    const target = state.board[toR][toC];
    if (target && target.owner === playerRole) return; // 自駒の上には進めない

    // 相手の駒を追い出す処理
    if (target && target.owner !== playerRole) {
      if (playerRole === 'p1') {
        target.isCatcher ? state.exiled.p1.catcher++ : state.exiled.p1.nonCatcher++;
      } else {
        target.isCatcher ? state.exiled.p2.catcher++ : state.exiled.p2.nonCatcher++;
      }
    }

    // 移動実行
    state.board[toR][toC] = piece;
    state.board[fromR][fromC] = null;

    // 1. 追い出しによる勝利判定
    if (checkExileWin(state)) {
      broadcastState(currentRoom);
      return;
    }

    // 手番交代
    state.turn = state.turn === 'p1' ? 'p2' : 'p1';

    // 2. 次の手番開始時の「ネズミ捕獲維持」勝利判定
    if (checkCornerCaptureWin(state)) {
      broadcastState(currentRoom);
      return;
    }

    broadcastState(currentRoom);
  });

  // 切断処理
  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const state = rooms[currentRoom];

    if (state.players.p1.id === socket.id) {
      state.players.p1.id = null;
      state.players.p1.ready = false;
    } else if (state.players.p2.id === socket.id) {
      state.players.p2.id = null;
      state.players.p2.ready = false;
    }

    // 誰かが抜けたら初期化
    if (!state.players.p1.id && !state.players.p2.id) {
      delete rooms[currentRoom];
    } else {
      state.phase = 'setup';
      state.board = Array(6).fill(null).map(() => Array(6).fill(null));
      broadcastState(currentRoom);
    }
  });
});

function stateTurn(roomId) {
  return rooms[roomId] ? rooms[roomId].turn : null;
}

// 初期配置を盤面に反映
function applySetupToBoard(state) {
  // P1 (手前下側 縦2*横4: 行4,5 / 列1〜4)
  let idx = 0;
  for (let r = 4; r <= 5; r++) {
    for (let c = 1; c <= 4; c++) {
      state.board[r][c] = {
        owner: 'p1',
        isCatcher: state.players.p1.setup[idx++]
      };
    }
  }

  // P2 (奥上側 縦2*横4: 行0,1 / 列1〜4)
  idx = 0;
  for (let r = 0; r <= 1; r++) {
    for (let c = 1; c <= 4; c++) {
      state.board[r][c] = {
        owner: 'p2',
        isCatcher: state.players.p2.setup[idx++]
      };
    }
  }
}

// 追い出し勝利判定
function checkExileWin(state) {
  if (state.exiled.p1.nonCatcher >= 4) {
    endGame(state, 'p2', '白猫(P1)が捕らない猫を4匹全て追い出してしまいました！');
    return true;
  }
  if (state.exiled.p2.nonCatcher >= 4) {
    endGame(state, 'p1', '黒猫(P2)が捕らない猫を4匹全て追い出してしまいました！');
    return true;
  }
  if (state.exiled.p1.catcher >= 4) {
    endGame(state, 'p1', '白猫(P1)が相手の捕る猫を4匹全て追い出しました！');
    return true;
  }
  if (state.exiled.p2.catcher >= 4) {
    endGame(state, 'p2', '黒猫(P2)が相手の捕る猫を4匹全て追い出しました！');
    return true;
  }
  return false;
}

// ネズミ捕獲勝利判定
function checkCornerCaptureWin(state) {
  const targetCorners = state.turn === 'p1' ? P1_TARGET_CORNERS : P2_TARGET_CORNERS;
  for (const cornerKey of targetCorners) {
    const [r, c] = cornerKey.split(',').map(Number);
    const piece = state.board[r][c];
    if (piece && piece.owner === state.turn && piece.isCatcher) {
      const winnerName = state.turn === 'p1' ? '白猫(P1)' : '黒猫(P2)';
      endGame(state, state.turn, `${winnerName}がネズミの捕獲に成功しました！`);
      return true;
    }
  }
  return false;
}

function endGame(state, winnerRole, reason) {
  state.phase = 'ended';
  state.winner = winnerRole;
  state.winReason = reason;
}

// 【情報隠蔽の核心】受信者の役割に応じて正体(isCatcher)をマスクして送信
function broadcastState(roomId) {
  const roomSockets = io.sockets.adapter.rooms.get(roomId);
  if (!roomSockets) return;

  const state = rooms[roomId];

  for (const socketId of roomSockets) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;

    // ソケットごとの役割を特定
    let role = 'spectator';
    if (state.players.p1.id === socketId) role = 'p1';
    else if (state.players.p2.id === socketId) role = 'p2';

    // フィルタリングした盤面を作成
    const clientBoard = state.board.map(row =>
      row.map(cell => {
        if (!cell) return null;
        // ゲーム終了時、または本人の駒である場合のみ isCatcher を開示
        const reveal = state.phase === 'ended' || cell.owner === role;
        return {
          owner: cell.owner,
          isCatcher: reveal ? cell.isCatcher : null
        };
      })
    );

    socket.emit('game_state', {
      board: clientBoard,
      turn: state.turn,
      phase: state.phase,
      myRole: role,
      p1Ready: state.players.p1.ready,
      p2Ready: state.players.p2.ready,
      exiled: state.exiled,
      winner: state.winner,
      winReason: state.winReason
    });
  }
}

server.listen(PORT, () => {
  console.log(`サーバーが起動しました: http://localhost:${PORT}`);
});

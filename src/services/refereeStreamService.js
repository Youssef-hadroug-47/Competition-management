function createRefereeStreamHub({ snapshot, serialize, intervalMs = 1000 }) {
  const states = new Map();

  function stateKey(matchId, tournamentId) {
    return `${tournamentId}:${matchId}`;
  }

  function writeSubscriber(subscriber, payload, changed) {
    if (
      subscriber.closed
      || subscriber.res.writableEnded
      || subscriber.res.destroyed
    ) return false;

    try {
      subscriber.res.write(
        changed
          ? `event: match-update\ndata: ${payload}\n\n`
          : ': heartbeat\n\n',
      );
      return true;
    } catch {
      return false;
    }
  }

  function writeError(subscriber) {
    if (
      subscriber.closed
      || subscriber.res.writableEnded
      || subscriber.res.destroyed
    ) return false;
    try {
      subscriber.res.write(
        'event: stream-error\ndata: {"message":"Live updates temporarily unavailable"}\n\n',
      );
      return true;
    } catch {
      return false;
    }
  }

  function broadcastError(state) {
    for (const subscriber of [...state.subscribers]) {
      if (!writeError(subscriber)) removeSubscriber(state, subscriber);
    }
  }

  function removeSubscriber(state, subscriber) {
    subscriber.closed = true;
    state.subscribers.delete(subscriber);
    if (!state.subscribers.size) {
      clearInterval(state.timer);
      states.delete(state.key);
    }
  }

  async function poll(state) {
    if (state.inFlight) return state.inFlight;

    state.inFlight = snapshot(state.matchId, state.tournamentId)
      .then((data) => {
        const payload = serialize(data);
        const changed = payload !== state.lastPayload;
        state.lastPayload = payload;
        for (const subscriber of [...state.subscribers]) {
          if (!writeSubscriber(subscriber, payload, changed)) {
            removeSubscriber(state, subscriber);
          }
        }
        return payload;
      })
      .finally(() => {
        state.inFlight = null;
      });

    return state.inFlight;
  }

  function subscribe({ matchId, tournamentId, res }) {
    const key = stateKey(matchId, tournamentId);
    let state = states.get(key);
    if (!state) {
      state = {
        key,
        matchId,
        tournamentId,
        subscribers: new Set(),
        lastPayload: null,
        inFlight: null,
        timer: null,
      };
      states.set(key, state);
    }

    const subscriber = { res, closed: false };
    state.subscribers.add(subscriber);
    if (!state.timer) {
      state.timer = setInterval(() => {
        poll(state).catch(() => broadcastError(state));
      }, intervalMs);
      state.timer.unref?.();
    }

    const ready = state.lastPayload
      ? Promise.resolve().then(() => {
        if (!writeSubscriber(subscriber, state.lastPayload, true)) {
          removeSubscriber(state, subscriber);
        }
      })
      : poll(state).then(() => {
        // The poll broadcasts the initial payload to every subscriber,
        // including subscribers added while the snapshot was in flight.
      });

    return {
      ready,
      unsubscribe: () => removeSubscriber(state, subscriber),
    };
  }

  return {
    subscribe,
    getActiveStreamCount: () => [...states.values()]
      .reduce((count, state) => count + state.subscribers.size, 0),
    getActiveMatchCount: () => states.size,
    reportPollingError: (matchId, tournamentId) => {
      const state = states.get(stateKey(matchId, tournamentId));
      if (state) broadcastError(state);
    },
  };
}

module.exports = { createRefereeStreamHub };

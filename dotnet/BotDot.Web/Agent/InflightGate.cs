// Concurrency gate per usuario para /api/chat/send.
// Bloquea un segundo POST de la misma user_id mientras el primero esta en
// vuelo. Equivalente al src/utils/inflight.js del Node.
//
// Implementacion: HashSet con lock — singleton, en memoria. Si la app
// escala a multi-process habria que mover a Redis SETNX, pero por ahora
// MVP single-process basta.

using System.Collections.Concurrent;

namespace BotDot.Web.Agent;

public interface IInflightGate
{
    bool IsInflight(long userId);
    bool MarkInflight(long userId);   // true si lo marco, false si ya estaba
    void Clear(long userId);
}

public class InMemoryInflightGate : IInflightGate
{
    private readonly ConcurrentDictionary<long, byte> _set = new();
    public bool IsInflight(long userId) => _set.ContainsKey(userId);
    public bool MarkInflight(long userId) => _set.TryAdd(userId, 0);
    public void Clear(long userId) => _set.TryRemove(userId, out _);
}

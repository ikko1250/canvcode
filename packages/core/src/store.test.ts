import { describe, expect, it } from 'vitest'
import { History } from './history.ts'
import { Store, type StoreEvent } from './store.ts'

interface Item {
  id: string
  value: number
}

function setup() {
  const store = new Store<Item>()
  const events: StoreEvent<Item>[] = []
  store.listen((event) => events.push(event))
  const history = new History(store)
  return { store, events, history }
}

describe('store', () => {
  it('records adds, updates and removes as one patch', () => {
    const { store, events } = setup()
    store.transact('create', (tx) => {
      tx.put({ id: 'a', value: 1 })
      tx.put({ id: 'b', value: 2 })
    })
    store.transact('edit', (tx) => {
      tx.update('a', (item) => ({ ...item, value: 10 }))
      tx.remove('b')
    })
    const commit = events.filter((event) => event.phase === 'commit')
    expect(commit).toHaveLength(2)
    const patch = commit[1].patch
    expect(patch.get('a')).toEqual({ before: { id: 'a', value: 1 }, after: { id: 'a', value: 10 } })
    expect(patch.get('b')).toEqual({ before: { id: 'b', value: 2 }, after: undefined })
  })

  it('drops records that were created and removed in the same transaction', () => {
    const { store, events } = setup()
    store.transact('noop', (tx) => {
      tx.put({ id: 'a', value: 1 })
      tx.remove('a')
    })
    expect(events.filter((event) => event.phase === 'commit')).toHaveLength(0)
  })

  it('reports progress during a long transaction and restores on cancel', () => {
    const { store, events } = setup()
    store.transact('create', (tx) => tx.put({ id: 'a', value: 0 }))
    const tx = store.begin('drag')
    for (let i = 1; i <= 3; i++) {
      tx.update('a', (item) => ({ ...item, value: i }))
      tx.flush()
    }
    expect(store.get('a')!.value).toBe(3)
    tx.cancel()
    expect(store.get('a')!.value).toBe(0)
    expect(events.filter((event) => event.label === 'drag' && event.phase === 'progress')).toHaveLength(4)
    expect(events.some((event) => event.label === 'drag' && event.phase === 'commit')).toBe(false)
  })

  it('runs hooks synchronously inside the transaction', () => {
    const { store, events } = setup()
    store.setHooks({
      afterDelete: (item, tx) => {
        if (item.id === 'a') tx.remove('a-child')
      },
    })
    store.transact('create', (tx) => {
      tx.put({ id: 'a', value: 1 })
      tx.put({ id: 'a-child', value: 2 })
    })
    store.transact('delete', (tx) => tx.remove('a'))
    expect(store.has('a-child')).toBe(false)
    expect(events.at(-1)!.patch.size).toBe(2)
  })

  it('rejects nested transactions', () => {
    const { store } = setup()
    const tx = store.begin('outer')
    expect(() => store.begin('inner')).toThrow()
    tx.commit()
  })
})

describe('history', () => {
  it('undoes and redoes a transaction', () => {
    const { store, history } = setup()
    store.transact('create', (tx) => tx.put({ id: 'a', value: 1 }))
    store.transact('edit', (tx) => tx.update('a', (item) => ({ ...item, value: 2 })))
    expect(history.undo().ok).toBe(true)
    expect(store.get('a')!.value).toBe(1)
    expect(history.undo().ok).toBe(true)
    expect(store.has('a')).toBe(false)
    expect(history.redo().ok).toBe(true)
    expect(history.redo().ok).toBe(true)
    expect(store.get('a')!.value).toBe(2)
    expect(history.redo()).toEqual({ ok: false, reason: 'empty' })
  })

  it('keeps separate stacks per scope', () => {
    const { store, history } = setup()
    store.transact('a', (tx) => tx.put({ id: 'a', value: 1 }), { scope: 'canvas:1' })
    store.transact('b', (tx) => tx.put({ id: 'b', value: 1 }), { scope: 'canvas:2' })
    history.undo('canvas:1')
    expect(store.has('a')).toBe(false)
    expect(store.has('b')).toBe(true)
  })

  it('refuses to undo when the record changed afterwards', () => {
    const { store, history } = setup()
    store.transact('create', (tx) => tx.put({ id: 'a', value: 1 }), { scope: 'canvas:1' })
    store.transact('elsewhere', (tx) => tx.update('a', (item) => ({ ...item, value: 5 })), {
      scope: 'canvas:2',
    })
    expect(history.undo('canvas:1')).toEqual({ ok: false, reason: 'conflict' })
    expect(store.get('a')!.value).toBe(5)
  })

  it('clears redo when a new change is recorded and ignores unrecorded changes', () => {
    const { store, history } = setup()
    store.transact('create', (tx) => tx.put({ id: 'a', value: 1 }))
    history.undo()
    store.transact('other', (tx) => tx.put({ id: 'b', value: 1 }))
    expect(history.canRedo()).toBe(false)
    store.transact('silent', (tx) => tx.put({ id: 'c', value: 1 }), { history: 'ignore' })
    history.undo()
    expect(store.has('b')).toBe(false)
    expect(store.has('c')).toBe(true)
  })
})

describe('beforeFlush', () => {
  it('derives values before listeners hear about a change, and includes them in the same event', () => {
    const { store, history } = setup()
    // b は、いつも a の 2 倍になる
    store.setHooks({
      beforeFlush: (pending, tx) => {
        const a = pending.get('a')?.after
        if (a && store.get('b')?.value !== a.value * 2) tx.put({ id: 'b', value: a.value * 2 })
      },
    })
    const events: StoreEvent<Item>[] = []
    store.listen((event) => events.push(event))
    store.transact('create', (tx) => tx.put({ id: 'a', value: 1 }))
    expect(store.get('b')!.value).toBe(2)
    expect([...events.at(-1)!.patch.keys()].sort()).toEqual(['a', 'b'])

    // ドラッグの途中経過でも合わせ直され、Undo で一緒に戻る
    const tx = store.begin('drag')
    tx.put({ id: 'a', value: 5 })
    tx.flush()
    expect(store.get('b')!.value).toBe(10)
    tx.commit()
    history.undo()
    expect(store.get('b')!.value).toBe(2)
  })

  it('is not called when a transaction is cancelled', () => {
    const { store } = setup()
    let calls = 0
    store.setHooks({ beforeFlush: () => void calls++ })
    const tx = store.begin('drag')
    tx.put({ id: 'a', value: 1 })
    tx.flush()
    tx.cancel()
    expect(calls).toBe(1)
    expect(store.has('a')).toBe(false)
  })
})

/**
 * Relay 的浏览器半：设置面板里的「应用权限」页。
 *
 * 只做展示和操作，手里没有凭证不参与授权判断——放松权限的操作会由 Host
 * 弹一次系统确认框，所以这里的请求被伪造也提不了权。
 */

window.__ModuleLoader__.load({
  id: '@kir_sleeping/dsh-relay',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const BASE = '/x/relay'
    const LEVELS = [
      { value: 0, label: '禁止' },
      { value: 1, label: '每条确认' },
      { value: 2, label: '信任已确认标记' },
      { value: 3, label: '完全信任' },
    ]

    const styles = {
      intro: { opacity: 0.75, lineHeight: 1.6, margin: '0 0 16px' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
      th: { textAlign: 'left', fontWeight: 600, padding: '6px 8px', borderBottom: '1px solid currentColor', opacity: 0.6 },
      td: { padding: '8px', borderBottom: '1px solid currentColor', verticalAlign: 'middle' },
      actions: { display: 'flex', gap: 6, flexWrap: 'wrap' },
      button: {
        font: 'inherit', fontSize: 12, padding: '3px 8px', cursor: 'pointer',
        color: 'inherit', background: 'transparent', border: '1px solid currentColor',
        borderRadius: 6, opacity: 0.85,
      },
      select: {
        font: 'inherit', fontSize: 12, padding: '3px 6px', color: 'inherit',
        background: 'transparent', border: '1px solid currentColor', borderRadius: 6,
      },
      error: {
        margin: '0 0 12px', padding: '8px 10px', borderRadius: 6,
        border: '1px solid currentColor', color: 'inherit', fontSize: 12, opacity: 0.9,
      },
      empty: { opacity: 0.6, padding: '12px 0' },
    }

    async function request(method, path, body) {
      const init = { method }
      if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' }
        init.body = JSON.stringify(body)
      }
      const response = await fetch(BASE + path, init)
      let payload = {}
      try {
        payload = await response.json()
      } catch {
        payload = {}
      }
      if (!response.ok) {
        const error = new Error(`${payload.code || `HTTP ${response.status}`}：${payload.message || ''}`)
        throw error
      }
      return payload
    }

    function RelaySettings() {
      const [rows, setRows] = React.useState([])
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          const payload = await request('GET', '/sources')
          setRows(Array.isArray(payload.sources) ? payload.sources : [])
        } catch (failure) {
          setError(String(failure.message || failure))
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const run = React.useCallback(async (path, body) => {
        setBusy(true)
        setError('')
        try {
          await request('POST', path, body)
        } catch (failure) {
          setError(String(failure.message || failure))
        } finally {
          setBusy(false)
          load()
        }
      }, [load])

      const rows_ = rows.map((row) => h('tr', { key: row.source },
        h('td', { style: styles.td }, row.source),
        h('td', { style: styles.td },
          h('select', {
            style: styles.select,
            value: String(row.level),
            disabled: busy || !row.hasFingerprint,
            onChange: (event) => {
              const level = Number(event.currentTarget.value)
              if (level !== row.level) run('/sources/level', { source: row.source, level })
            },
          }, LEVELS.map((option) => h('option', { key: option.value, value: String(option.value) }, option.label)))),
        h('td', { style: styles.td }, row.hasFingerprint ? '已持有' : '—'),
        h('td', { style: styles.td },
          h('div', { style: styles.actions },
            row.hasFingerprint
              ? h('button', { style: styles.button, disabled: busy, onClick: () => run('/sources/reset', { source: row.source }) }, '重置凭证')
              : h('button', { style: styles.button, disabled: busy, onClick: () => run('/sources/clear', { source: row.source }) }, '解除禁止'),
            h('button', { style: styles.button, disabled: busy, onClick: () => run('/sources/delete', { source: row.source }) }, '删除')))))

      return h('div', null,
        h('p', { style: styles.intro },
          '这里的每个应用都能把任务交给同一个 agent，并共享「外部任务」会话的上下文。',
          '「完全信任」意味着它可以在不询问你的情况下让 agent 执行任何操作；',
          '提高权限会弹出一次系统确认框。'),
        error ? h('p', { style: styles.error }, error) : null,
        rows.length === 0
          ? h('p', { style: styles.empty }, '还没有外部应用接入。应用第一次调用时会弹出确认框。')
          : h('table', { style: styles.table },
            h('thead', null, h('tr', null,
              h('th', { style: styles.th }, '应用'),
              h('th', { style: styles.th }, '级别'),
              h('th', { style: styles.th }, '凭证'),
              h('th', { style: styles.th }, '操作'))),
            h('tbody', null, rows_)))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'relay',
          order: 25,
          label: '应用权限',
        }, RelaySettings))
      },
    }
  },
})

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
      header: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, margin: '0 0 12px',
      },
      hint: { opacity: 0.7, fontSize: 13, lineHeight: 1.6 },
      helpButton: {
        font: 'inherit', fontSize: 13, width: 24, height: 24, lineHeight: '22px',
        textAlign: 'center', cursor: 'pointer', color: 'inherit', background: 'transparent',
        border: '1px solid currentColor', borderRadius: 999, opacity: 0.7, flex: 'none',
      },
      help: {
        margin: '0 0 16px', padding: '12px 14px', borderRadius: 8,
        border: '1px solid currentColor', fontSize: 13, lineHeight: 1.75, opacity: 0.9,
      },
      helpTitle: { fontWeight: 600, margin: '0 0 8px' },
      helpList: { margin: '0 0 12px', paddingLeft: 18 },
      helpItem: { margin: '0 0 6px' },
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
      const [helpOpen, setHelpOpen] = React.useState(false)

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

      const help = h('div', { style: styles.help },
        h('p', { style: styles.helpTitle }, '四个级别分别是什么意思'),
        h('ul', { style: styles.helpList },
          h('li', { style: styles.helpItem },
            h('b', null, '0 禁止'),
            '　直接拒绝，不弹窗，应用收不到任何回应。'),
          h('li', { style: styles.helpItem },
            h('b', null, '1 每条确认'),
            '　应用每发一条消息都弹一次系统确认框。新接入的应用默认是这一级。'),
          h('li', { style: styles.helpItem },
            h('b', null, '2 信任已确认标记'),
            '　应用声明是你亲手触发的就放行；它自己在后台发起的仍然弹窗。'),
          h('li', { style: styles.helpItem },
            h('b', null, '3 完全信任'),
            '　不再询问，直接执行。')),
        h('p', { style: styles.helpTitle }, '给权限前请想清楚'),
        h('ul', { style: styles.helpList },
          h('li', { style: styles.helpItem },
            '这套权限防的是',
            h('b', null, '有害请求'),
            '，不是防你自己。你信任的应用可以给 3 级——那样它全程没有弹窗，用起来才顺。'),
          h('li', { style: styles.helpItem },
            h('b', null, '3 级就是全权限：'),
            'agent 能读写文件、执行命令、联网。只给自己写的或完全信得过的应用。'),
          h('li', { style: styles.helpItem },
            '放宽权限（提高级别、重置凭证）会弹一次系统确认框；收紧（降低级别、禁止）立即生效，不弹窗。'),
          h('li', { style: styles.helpItem },
            '拿不准就留在 1 级，先看着它跑几次再决定。')))

      return h('div', null,
        h('div', { style: styles.header },
          h('span', { style: styles.hint }, '各权限级别的含义和给权限的注意事项，点右侧问号。'),
          h('button', {
            type: 'button',
            style: styles.helpButton,
            title: helpOpen ? '收起说明' : '查看说明',
            onClick: () => setHelpOpen((open) => !open),
          }, '?')),
        helpOpen ? help : null,
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

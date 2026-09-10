(function() {
  'use strict';

  kintone.events.on('app.record.index.show', function(event) {
    // 既にあればスキップ
    if (document.getElementById('bulk-delete-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'bulk-delete-btn';
    btn.textContent = '絞り込み結果を全件削除';
    btn.style.cssText = 'margin:8px; background:#e74c3c; color:white; border:none; padding:6px 14px; cursor:pointer; border-radius:4px; font-size:13px;';

    const status = document.createElement('span');
    status.id = 'bulk-delete-status';
    status.style.cssText = 'margin-left:12px; font-size:13px; color:#555;';

    btn.addEventListener('click', async function() {
      const appId = kintone.app.getId();
      const query = kintone.app.getQueryCondition() || '';

      const countRes = await kintone.api('/k/v1/records', 'GET', {
        app: appId,
        query: (query ? query + ' ' : '') + 'limit 1',
        totalCount: true
      });
      const total = countRes.totalCount;

      if (!confirm(`${total.toLocaleString()}件を削除します。よろしいですか？`)) return;

      btn.disabled = true;
      let deletedCount = 0;
      const statusEl = document.getElementById('bulk-delete-status');

      try {
        while (true) {
          const res = await kintone.api('/k/v1/records', 'GET', {
            app: appId,
            query: (query ? query + ' ' : '') + 'limit 100',
            fields: ['$id']
          });

          const ids = res.records.map(r => r['$id'].value);
          if (ids.length === 0) break;

          await kintone.api('/k/v1/records', 'DELETE', { app: appId, ids: ids });

          deletedCount += ids.length;
          statusEl.textContent = `削除中... ${deletedCount.toLocaleString()} / ${total.toLocaleString()} 件`;

          await new Promise(r => setTimeout(r, 200));
        }

        statusEl.textContent = `✅ ${deletedCount.toLocaleString()}件完了`;
        location.reload();
      } catch (e) {
        statusEl.textContent = `❌ エラー（${deletedCount.toLocaleString()}件削除済み）: ${e.message}`;
        console.error(e);
      } finally {
        btn.disabled = false;
      }
    });

    // ★ headerの取得をここに移動（appendの直前）
    const header = kintone.app.getHeaderSpaceElement();
    if (!header) return; // nullなら諦める
    header.appendChild(btn);
    header.appendChild(status);
  });
})();
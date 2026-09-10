'use strict';
// NEED: KintoneAPIFunctions.js
// NEED: ui.js

/* ===================================================================
 * このアプリ専用の設定（複製時はここだけ書き換える）
 * 共有の config.js には手を入れない
 * =================================================================== */

/** 配信対象を取得するマスタアプリ */
const MAIL_CONFIG = {
  master: {
    id: 61,                      // 親カテゴリマスタ（テスト環境）
    api_token: 'u5FPJS27zYFOoDRysWEbtplBWwmpTLk6sjbteBsa',       // このアプリ用に発行したトークン
    view_id: '5522551'           // メール配信対象ビュー
  }
};

/** 配信フラグの選択肢 */
const FLAG_UNSENT = '未送信';
const FLAG_SENT = '送信済';

/** マスタ側のフィールドコード */
const F_MASTER = {
  メーカーコード: 'メーカーコード',
  メーカー名: 'メーカー名',
  連絡先テーブル: '連絡先',
  担当者名: '担当者名',
  宛先種別: '宛先種別',
  メールアドレス: 'メールアドレス'
};

/** このアプリ（配信アプリ）側のフィールドコード */
const F_DELIVERY = {
  配信ID: '配信ID',
  配信名: '配信名',
  配信日: '配信日',
  配信フラグ: '配信フラグ',
  メーカーID: 'メーカーID',
  メーカー名: 'メーカー名',
  担当者名TO: '担当者名_TO',
  メール宛先TO: 'メール宛先_TO',
  担当者名CC: '担当者名_CC',
  メール宛先CC: 'メール宛先_CC'
};

/* =================================================================== */

/**
 * ボタン設置
 */
setButton('generateDeliveryList', '配信リスト生成', generateDeliveryList, true);
setButton('markAsSent', '送信済にする', markAsSent, true);

/**
 * 宛先種別のプルダウンを設置（選択肢はマスタのフィールド設定から自動取得）
 */
kintone.events.on('app.record.index.show', async (event) => {
  const SELECT_ID = 'mailTypeSelect';
  if (document.getElementById(SELECT_ID)) return event;

  const space = kintone.app.getHeaderMenuSpaceElement();
  if (!space) return event;

  const wrapper = document.createElement('span');
  wrapper.style.margin = '10px';
  wrapper.innerHTML = '<span style="margin-right:6px;">宛先種別:</span>';

  const select = document.createElement('select');
  select.id = SELECT_ID;
  select.className = 'kintoneplugin-dropdown';
  wrapper.appendChild(select);
  space.insertBefore(wrapper, space.firstChild);

  try {
    const types = await fetchAddressTypes();
    types.forEach(type => {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = type;
      select.appendChild(option);
    });
  } catch (e) {
    console.error('宛先種別の取得に失敗しました。', e);
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '取得失敗';
    select.appendChild(option);
  }

  return event;
});

/**
 * マスタの宛先種別フィールドから、種別名（TO/CCを除いた部分）を取得する
 */
async function fetchAddressTypes() {
  const client = new KintoneRestAPIClient({ auth: { apiToken: MAIL_CONFIG.master.api_token } });
  const resp = await client.app.getFormFields({ app: MAIL_CONFIG.master.id });

  const table = resp.properties[F_MASTER.連絡先テーブル];
  const field = table && table.fields ? table.fields[F_MASTER.宛先種別] : null;
  if (!field || !field.options) {
    throw new Error(`"${F_MASTER.宛先種別}" の選択肢が取得できませんでした。`);
  }

  // 選択肢を表示順に並べ、「フォロー（TO）」→「フォロー」に変換して重複を除く
  const labels = Object.values(field.options)
    .sort((a, b) => Number(a.index) - Number(b.index))
    .map(option => option.label.replace(/（TO）|（CC）/g, '').trim());

  return [...new Set(labels)];
}



/**
 * 配信リスト生成のメイン処理
 */
async function generateDeliveryList(updateStatus = () => {}) {

  /**
   * 宛先種別の選択値を取得
   */
  const select = document.getElementById('mailTypeSelect');
  const baseType = select ? select.value : '';
  if (!baseType) {
    throw new Error('宛先種別が選択されていません。');
  }
  const TYPE_TO = `${baseType}（TO）`;
  const TYPE_CC = `${baseType}（CC）`;

  /**
   * 未送信レコードが残っていないか確認（二重送信の防止）
   */
  updateStatus('未送信レコードを確認中...');
  const unsent = await fetchRecordsByQuery(`${F_DELIVERY.配信フラグ} in ("${FLAG_UNSENT}")`);
  if (unsent.length > 0) {
    const ok = confirm(
      `未送信のレコードが${unsent.length}件残っています。\n` +
      `前回分の「送信済にする」を押し忘れていませんか？\n\n` +
      `このまま生成すると、送信時に前回分も一緒に送られる可能性があります。\n続行しますか？`
    );
    if (!ok) {
      throw new Error('処理を中止しました。');
    }
  }

  /**
   * 配信名の入力（1回だけ聞いて全レコードに同じ値を入れる）
   */
  const deliveryName = (prompt('配信名を入力してください。\n例: 2026年夏季休業のご案内') || '').trim();
  if (!deliveryName) {
    throw new Error('配信名が入力されなかったため、処理を中止しました。');
  }

  const now = new Date();
  const lotId = formatLotId(now);
  const today = formatDate(now);

  /**
   * マスタから配信対象を取得
   */
  updateStatus('配信対象を取得中...');
  const masterRecords = await fetchRecordsFromApp(
    MAIL_CONFIG.master.api_token,
    MAIL_CONFIG.master.id,
    MAIL_CONFIG.master.view_id
  );
  console.log('配信対象マスタ:', masterRecords);

  if (masterRecords.length === 0) {
    throw new Error('配信対象が0件でした。ビューの絞り込み条件を確認してください。');
  }

  /**
   * 連絡先テーブルから宛先種別に一致する行を抽出し、メーカー単位の配信データを組み立てる
   */
  updateStatus('宛先を抽出中...');
  const deliveryList = [];
  const skipped = [];

  masterRecords.forEach(record => {
    const manufacturerCode = record[F_MASTER.メーカーコード]?.value || '';
    const manufacturerName = record[F_MASTER.メーカー名]?.value || '';
    const rows = record[F_MASTER.連絡先テーブル]?.value || [];

    const to = { names: [], mails: [] };
    const cc = { names: [], mails: [] };

    rows.forEach(row => {
      const types = row.value[F_MASTER.宛先種別]?.value || []; // チェックボックスは配列
      const name = (row.value[F_MASTER.担当者名]?.value || '').trim();
      const mail = (row.value[F_MASTER.メールアドレス]?.value || '').trim();
      if (!mail) return; // アドレス未登録の行は無視

      if (types.includes(TYPE_TO)) {
        to.names.push(name);
        to.mails.push(mail);
      } else if (types.includes(TYPE_CC)) {
        cc.names.push(name);
        cc.mails.push(mail);
      }
    });

    // TOが1件も無いメーカーは送りようが無いのでスキップ（後でまとめて警告）
    if (to.mails.length === 0) {
      skipped.push(manufacturerName);
      return;
    }

    deliveryList.push({ manufacturerCode, manufacturerName, to, cc });
  });

  console.log('配信リスト:', deliveryList);
  if (skipped.length > 0) {
    console.warn('TO未設定のためスキップ:', skipped);
  }

  if (deliveryList.length === 0) {
    throw new Error(`宛先種別 "${TYPE_TO}" の担当者が1件も見つかりませんでした。`);
  }

  /**
   * 配信レコードを作成（100件ずつ一括登録）
   */
  const appId = kintone.app.getId();
  const records = deliveryList.map(item => ({
    [F_DELIVERY.配信ID]: { value: lotId },
    [F_DELIVERY.配信名]: { value: deliveryName },
    [F_DELIVERY.配信日]: { value: today },
    [F_DELIVERY.配信フラグ]: { value: FLAG_UNSENT },
    [F_DELIVERY.メーカーID]: { value: item.manufacturerCode },
    [F_DELIVERY.メーカー名]: { value: item.manufacturerName },
    [F_DELIVERY.担当者名TO]: { value: item.to.names.join(',') },
    [F_DELIVERY.メール宛先TO]: { value: item.to.mails.join(',') },
    [F_DELIVERY.担当者名CC]: { value: item.cc.names.join(',') },
    [F_DELIVERY.メール宛先CC]: { value: item.cc.mails.join(',') }
  }));

  const CHUNK_SIZE = 100;
  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunk = records.slice(i, i + CHUNK_SIZE);
    updateStatus(`配信レコード作成中... (${Math.min(i + chunk.length, records.length)}/${records.length})`);
    await addAppRecords({ app: appId, records: chunk });
  }

  let message = `配信リストを${records.length}件作成しました。\n配信名: ${deliveryName}\n配信ID: ${lotId}`;
  if (skipped.length > 0) {
    message += `\n\n以下のメーカーはTOの宛先が未設定のためスキップしました。\n${skipped.join('\n')}`;
  }
  alert(message);

  return;
}

/**
 * 一覧に表示中のレコードを「送信済」に更新する
 */
async function markAsSent(updateStatus = () => {}) {

  updateStatus('対象レコードを取得中...');
  const targets = await fetchRecordsByQuery(kintone.app.getQueryCondition() || '');

  // 既に送信済のものは除外
  const records = targets
    .filter(record => record[F_DELIVERY.配信フラグ]?.value !== FLAG_SENT)
    .map(record => ({
      id: record.$id.value,
      record: { [F_DELIVERY.配信フラグ]: { value: FLAG_SENT } }
    }));

  if (records.length === 0) {
    throw new Error('更新対象のレコードがありません。（すべて送信済、または一覧が0件です）');
  }

  const ok = confirm(`一覧に表示中の${records.length}件を「${FLAG_SENT}」に更新します。よろしいですか？`);
  if (!ok) {
    throw new Error('処理を中止しました。');
  }

  const appId = kintone.app.getId();
  const CHUNK_SIZE = 100;
  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunk = records.slice(i, i + CHUNK_SIZE);
    updateStatus(`更新中... (${Math.min(i + chunk.length, records.length)}/${records.length})`);
    await updateAppRecords({ app: appId, records: chunk });
  }

  alert(`${records.length}件を「${FLAG_SENT}」に更新しました。`);
  return;
}

// --- Utility Functions ---

/** このアプリのレコードを条件指定で全件取得 */
async function fetchRecordsByQuery(condition = '') {
  const client = new KintoneRestAPIClient();
  return await client.record.getAllRecords({ app: kintone.app.getId(), condition: condition });
}

/** レコード一括登録（100件まで） */
async function addAppRecords(requestBody) {
  try {
    const resp = await kintone.api(kintone.api.url('/k/v1/records.json', true), 'POST', requestBody);
    console.log(`レコードを${resp.ids.length}件追加しました。`);
    return resp;
  } catch (error) {
    console.error('レコードの一括追加に失敗しました。', error);
    throw error;
  }
}

/** レコード一括更新（100件まで） */
async function updateAppRecords(requestBody) {
  try {
    const resp = await kintone.api(kintone.api.url('/k/v1/records.json', true), 'PUT', requestBody);
    console.log(`レコードを${resp.records.length}件更新しました。`);
    return resp;
  } catch (error) {
    console.error('レコードの一括更新に失敗しました。', error);
    throw error;
  }
}

/** 配信ID（例: 20260818-1030） */
function formatLotId(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

/** kintoneの日付フィールド用（YYYY-MM-DD、ローカル日付） */
function formatDate(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
/**
 * 一覧画面カスタマイズ：指定フィールドの列（各行のセル）に背景色を付ける
 *
 * 対象：
 *   ブルー … メーカー_売上額_税抜_ / メーカー_消費税 / 調整消費税額 / 支払額
 *   黄色 … 請求書との差額
 *
 * 適用範囲：一覧画面のみ（レコード詳細画面には適用しない）
 *
 * 参考：cybozu developer network公式サンプル
 * https://cybozu.dev/ja/kintone/tips/development/customize/record-list-customize/conditional-formatting-list-detail-view/
 */
(() => {
  'use strict';

  // 色はここで調整可能
  const COLOR_BLUE = '#E3F2FD';   // 薄い水色
  const COLOR_YELLOW = '#FFF9C4'; // 薄い黄色

  // ブルーにするフィールドコード
  const BLUE_FIELD_CODES = [
    'メーカー_売上額_税抜_',
    'メーカー_消費税',
    '調整消費税額',
    '支払額',
  ];

  // 黄色にするフィールドコード
  const YELLOW_FIELD_CODES = [
    '請求書との差額',
  ];

  // 一覧の行間に引かれている罫線と同じ色・太さ（DevToolsで確認済み）
  const ROW_BORDER = '1px solid #e3e7e8';

  const applyColor = (fieldCode, color) => {
    const elements = kintone.app.getFieldElements(fieldCode);
    if (!elements) {
      // 一覧に列が表示されていない場合など、要素が取得できないことがある
      return;
    }
    elements.forEach((el) => {
      // 取得した要素に直接、背景色と下線（罫線）を付ける。
      // 背景色だけだと本来の行の罫線が隠れて見えなくなるため、
      // 同じ色・太さの border-bottom を明示的に上書きで足す。
      el.style.backgroundColor = color;
      el.style.borderBottom = ROW_BORDER;
    });
  };

  kintone.events.on('app.record.index.show', (event) => {
    BLUE_FIELD_CODES.forEach((code) => applyColor(code, COLOR_BLUE));
    YELLOW_FIELD_CODES.forEach((code) => applyColor(code, COLOR_YELLOW));
    return event;
  });
})();

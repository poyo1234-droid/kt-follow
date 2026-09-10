(function() {
  'use strict';

  // 各種定義
  window.config = {
    production: {
      kintone: {
        app: {
          'Z_売上（発送）': {
            id: 32,
            api_token: '***',
            view: {
              '前月売上': '5521526'
            }
          },
          'Z_特別処理・商品回収明細': {
            id: 42,
            api_token: '***',
            view: {
              '前月分明細': '5521525'
            }
          },
          'メーカーマスタ from SQL': {
            id: 40,
            api_token: '***',
            view: {
              '連絡先': '5521650'
            }
          },
          '子カテゴリマスタ': {
            id: 44,
            api_token: '***',
            view: {
            }
          },
          '商品マスタ': {
            id: 51,
            api_token: '***',
            view: {
              'CS品番': '5521670',
              '在庫あり商品': '5522317',             
              '販売中の商品': '5522571'
            }
          },
          'Z_取引明細': {
            id: 43,
            api_token: '***',
            view: {
              '先月売上': '5521523'
            }
          },
          'Z_売上（注文日）': {
            id: 76,
            api_token: '***',
            view: {
              '前回セール期間': '5522319'
            }
          },
          '在庫': {
            id: 64,
            api_token: '***',
            view: {
            }
          },
          '在庫分析': {
            id: 65,
            api_token: '***',
            view: {
            }
          },
          'salegoods': {
            id: 63,
            api_token: '***',
            view: {
            }
          },
          '親カテゴリマスタ': {
            id: 61,
            api_token: '***',
            view: {
              '連絡先': '5522179'
            }
          },
          'セール返答表': {
            id: 60,
            api_token: '***',
            view: {
            }
          },
          'フォローリスト': {
            id: 74,
            api_token: '***',
            view: {
              '支払確認業務（請求書未確認）': '5521685'
            }
          },
          '月末在庫報告書出力': {
            id: 73,
            api_token: '***',
            view: {
              '支払確認業務（請求書未確認）': '5521685'
            }
          },
          '発注メイン': {
            id: 36,
            api_token: '***',
            view: {
              '直近10日間発注': '5522331'
            }
          },
          '発注明細': {
            id: 35,
            api_token: '***',
            view: {
              '直近10日間発注': '5522327'
            }
          },
          'Goodsinfo': {
            id: 41,
            api_token: '***',
            view: {
              '先月精算分': '5522573'
            }
          },
          'ZOZO商品タイプマスタ': {
            id: 54,
            api_token: '***',
            view: {
            }
          }
        }
      },
      google: {
        api: {
          client_id: '***',
          secret: '***',
          refresh_token: '***'
        },
        drive: {
          '取引先別売上精算書出力': {
            target_folder_id: '1vPiaT2BGEyVCB_vQgl_bNp2jfUZlfb9H',
            template_spreadsheet_id: '1F5tBp2WjDHs3whlhqoiLeIO2xd14G6aoKZ5DwEQ9wNg'
          },
          '旭川在庫管理': {
            target_folder_id: '1_8jsJoIgYeZaZHxpwv1JuSWR5iBPk9I1',
            template_spreadsheet_id: '1ZBumCrmqbvX3_3PH22_Rf-KrleD2kMDnLDjFTicxt7I'
          },
          'フォロー業務': {
            target_folder_id: '1RNQESvFU2un0mWKh7aXWD3Ydxr7S4TG_',
            template_spreadsheet_id: '1dnzI_Tj_LMRhNzx8ebggZJHsMji25Bg72FiYlr34ioY'
          },
          'セール設定': {
            target_folder_id: '1dLjBhqeSiHAXSvmo5WBChONvAV0mZFUI',
            template_spreadsheet_id: '1B4Zv20QQbQyFauUcrfl6tf0QrrP-ah7TeV-BEHHn8rA'
          }
        }
      }
    },
    development: {
      kintone: {
        app: {
        }
      },
      google: {
        api: {
          client_id: '',
          secret: '',
          refresh_token: ''
        },
        drive: {
        }
      }
    }
  };
})();

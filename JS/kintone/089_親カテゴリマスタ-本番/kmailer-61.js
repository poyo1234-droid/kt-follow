var _kmailer_config = _kmailer_config || {
  api_token: "eyJhbGciOiJIUzUxMiJ9.eyJ1dWlkIjoiZjVkMWMxYzEtZDljYi00ZmU5LTgwM2UtMzgxYzllNWFhNDM4In0.iLDKUyZqqsjkN78qPQY0cbHWx2VDqIRpQQJaYhqM5lVerTEb2gLLwioneNKv4IgE0RQtbFHw3G0peVvpJK7kxQ"
  ,endpoint: "https://mailer.kintoneapp.com"
  ,mailset_id: "c5383a02-5985-4c13-bf6b-e0bcdffeaa40"
};

(function (){
  'use strict';

  var load_cdn = function(){
    var component_elems = document.getElementsByClassName('kmailer-component');
    if(document.getElementById("toyokumo_kMailer_JS") === null
        || component_elems.length === 0
        || (component_elems.length === 1 && component_elems[0].children.length === 0)){
      kintone.proxy(
        "https://mailer.kintoneapp.com/api/version",
        "GET",
        {"Content-Type": "application/json"},
        {},
        function(body, status, _){
          var s, appjs, l, appcss, v;
          v = JSON.parse(body).version;

          appcss = document.createElement("link");
          appcss.type = "text/css";
          appcss.async = true;
          appcss.rel = "stylesheet";
          appcss.href = "https://mailer.kintoneapp.com/cdn/css/main.css?v=" + v;
          l = document.getElementsByTagName("link")[0];
          l.parentNode.insertBefore(appcss, l);

          appjs = document.createElement("script");
          appjs.type = "text/javascript";
          appjs.async = true;
          appjs.src = "https://mailer.kintoneapp.com/cdn/js/kmailer.js?v=" + v;
          appjs.id = "toyokumo_kMailer_JS";
          s = document.getElementsByTagName("script")[0];
          s.parentNode.insertBefore(appjs, s);

          _kmailer_config.version = v;
        },
        function(err){
          console.log("Couldn't get current version");
        }
      );
    }
  };

  var add_app_component = function(target_elm){
    if(target_elm.querySelectorAll(".kmailer-component").length === 0){
      var elm;
      elm = document.createElement("div");
      elm.classList.add("kmailer-component");
      target_elm.appendChild(elm);
    }
  };

  // 一覧画面で表示する
  // <<-------------------------------------------------------------------------
  kintone.events.on('app.record.index.show', function(event){
    _kmailer_config.on_index = true;
    add_app_component(kintone.app.getHeaderMenuSpaceElement());
    load_cdn();
    return event;
  });
  // ------------------------------------------------------------------------->>

  // 詳細画面で表示する
  // <<-------------------------------------------------------------------------
  kintone.events.on('app.record.detail.show', function(event){
    _kmailer_config.on_index = false;
    add_app_component(kintone.app.record.getHeaderMenuSpaceElement());
    load_cdn();
    return event;
  });
  // ------------------------------------------------------------------------->>

})();

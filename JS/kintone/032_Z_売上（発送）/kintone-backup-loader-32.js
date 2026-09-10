var _kbackupConfig;

_kbackupConfig = _kbackupConfig || {};

_kbackupConfig = {
appCode: "ff783b29b42af88c943cfab469f1d66a5a5a31c2",
baseUrl: "//backup.kintoneapp.com"
};

(function() {
  "use strict"
  kintone.events.on('app.record.detail.show', function(event){
    _kbackupConfig.event = event;

    return event;
  });
  kintone.events.on('app.record.index.show', function(event){
    _kbackupConfig.event = event;

    return event;
  });

  var s, scr;
  scr = document.createElement("script");
  scr.type = "text/javascript";
  scr.async = true;
  scr.src = "//backup.kintoneapp.com/dist/kintone-lib/build.js";
  s = document.getElementsByTagName("script")[0];
  s.parentNode.insertBefore(scr, s);
})();

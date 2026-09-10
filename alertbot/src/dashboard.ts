/** Self-contained dashboard page (inline CSS/JS, polls the bot's /api endpoints). */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Candela · Signal Dashboard</title>
<link rel="manifest" href="/manifest.webmanifest"/>
<meta name="theme-color" content="#0e1013"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="apple-mobile-web-app-status-bar-style" content="black"/>
<link rel="icon" href="/icon.svg"/>
<link rel="apple-touch-icon" href="/icon.svg"/>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{
    color-scheme:dark;
    --bg:#0a0b0e; --surface:#131519; --surface2:#181b21; --hover:#1e2128;
    --line:#24282f; --line2:#353b45;
    --text:#edeff3; --muted:#9aa1ad; --dim:#616773;
    --accent:#7c9bff; --accent2:#a98bfa; --lux:#cba86a;
    --g:#4bbd8b; --r:#e56a63; --amber:#d8a94e;
    --chipbg:rgba(255,255,255,.05);
    /* Single source of truth for the site font. Change this one line to restyle every
       piece of text on the dashboard — headings, body, prices, tables, chips. */
    --font:'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
    --shadow:0 1px 2px rgba(0,0,0,.4),0 6px 22px -10px rgba(0,0,0,.6);
    --shadow-lg:0 8px 30px -10px rgba(0,0,0,.62),0 20px 60px -24px rgba(0,0,0,.55);
    --inset:inset 0 1px 0 rgba(255,255,255,.05);
    --ease:cubic-bezier(.22,.61,.24,1);
    --radius:14px;
  }
  :root[data-theme="light"]{
    color-scheme:light;
    --bg:#f4f5f8; --surface:#ffffff; --surface2:#fbfbfd; --hover:#f4f6f9;
    --line:#e7e9ee; --line2:#d3d8e0;
    --text:#141821; --muted:#586172; --dim:#939aa8;
    --accent:#4f6ef2; --accent2:#8b5cf6; --lux:#a9812f;
    --g:#12905f; --r:#cf4e4a; --amber:#a97b23;
    --chipbg:rgba(15,20,30,.045);
    --shadow:0 1px 2px rgba(15,23,42,.06),0 8px 24px -14px rgba(15,23,42,.14);
    --shadow-lg:0 10px 34px -12px rgba(15,23,42,.16),0 24px 60px -30px rgba(15,23,42,.14);
    --inset:inset 0 1px 0 rgba(255,255,255,.7);
  }
  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{margin:0;color:var(--text);background:var(--bg);font-family:var(--font);
    font-size:14px;line-height:1.45;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
  /* ambient luxury glow — a fixed aurora + soft edge vignette so scrolling stays crisp on mobile */
  body::before{content:'';position:fixed;inset:0;z-index:-1;pointer-events:none;
    background:
      radial-gradient(1150px 580px at 14% -10%, color-mix(in srgb,var(--accent) 13%,transparent), transparent 58%),
      radial-gradient(960px 560px at 104% -6%, color-mix(in srgb,var(--accent2) 11%,transparent), transparent 54%),
      radial-gradient(900px 700px at 50% 118%, color-mix(in srgb,var(--lux) 6%,transparent), transparent 60%);}
  body::after{content:'';position:fixed;inset:0;z-index:-1;pointer-events:none;
    background:radial-gradient(140% 100% at 50% 0%, transparent 62%, rgba(0,0,0,.28) 100%)}
  :root[data-theme="light"] body::after{background:radial-gradient(140% 100% at 50% 0%, transparent 68%, rgba(15,23,42,.05) 100%)}
  ::selection{background:color-mix(in srgb,var(--accent) 26%,transparent)}
  a{color:var(--accent);text-decoration:none}
  .wrap{max-width:1200px;margin:0 auto;padding:26px 22px 80px;position:relative}
  /* signature — a soft accent light-bar across the very top edge */
  .wrap::before{content:'';position:fixed;top:0;left:0;right:0;height:2px;z-index:10;pointer-events:none;
    background:linear-gradient(90deg,transparent 2%,color-mix(in srgb,var(--accent) 55%,transparent) 26%,color-mix(in srgb,var(--lux) 60%,transparent) 50%,color-mix(in srgb,var(--accent2) 55%,transparent) 74%,transparent 98%)}
  .wrap>.panel,.wrap>.cards{animation:rise .5s var(--ease) both}
  @keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion:reduce){*{animation-duration:.001ms!important;transition-duration:.001ms!important}}

  /* header */
  .top{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;
    margin:0 0 22px;padding-bottom:16px;border-bottom:1px solid var(--line)}
  .brand{display:flex;align-items:center;gap:10px;font-family:var(--font);font-size:16px;font-weight:600;letter-spacing:.1px;color:var(--text)}
  .brand .logo{color:var(--accent);filter:drop-shadow(0 0 6px color-mix(in srgb,var(--accent) 45%,transparent))}
  .live{width:7px;height:7px;border-radius:50%;background:var(--g);position:relative;flex:none}
  .live::after{content:'';position:absolute;inset:-3px;border-radius:50%;border:1px solid var(--g);opacity:.4;animation:ring 2.6s ease-out infinite}
  .live.down{background:var(--r)}
  .live.down::after{display:none}
  .connbanner{display:none;margin-bottom:12px;padding:9px 13px;border-radius:8px;background:color-mix(in srgb,var(--r) 12%,transparent);border:1px solid color-mix(in srgb,var(--r) 38%,transparent);color:var(--r);font-size:13px;font-weight:500}
  @keyframes ring{0%{transform:scale(.55);opacity:.5}100%{transform:scale(1.6);opacity:0}}
  .toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .stats{display:flex;flex-wrap:wrap;align-items:center;color:var(--muted);font-size:12.5px}
  .stats>span{padding:0 13px;border-right:1px solid var(--line);line-height:1.25}
  .stats>span:first-child{padding-left:0}
  .stats>span:last-child{border-right:none;padding-right:0}
  .stats b{color:var(--text);font-family:var(--font);font-weight:600}
  .mbias{font-size:12px;font-weight:600;letter-spacing:.3px;padding:5px 12px;border-radius:7px;border:1px solid var(--line);color:var(--muted);background:var(--surface)}
  .mbias.BULLISH{color:var(--g);border-color:color-mix(in srgb,var(--g) 34%,transparent);background:color-mix(in srgb,var(--g) 8%,transparent)}
  .mbias.BEARISH{color:var(--r);border-color:color-mix(in srgb,var(--r) 34%,transparent);background:color-mix(in srgb,var(--r) 8%,transparent)}
  .mbias.MIXED{color:var(--muted)}
  .mreg{font-size:12px;font-weight:600;letter-spacing:.3px;padding:5px 12px;border-radius:7px;border:1px solid var(--line);color:var(--muted);background:var(--surface);display:none}
  .mreg.bull{color:var(--g);border-color:color-mix(in srgb,var(--g) 34%,transparent);background:color-mix(in srgb,var(--g) 8%,transparent)}
  .mreg.bear{color:var(--r);border-color:color-mix(in srgb,var(--r) 34%,transparent);background:color-mix(in srgb,var(--r) 8%,transparent)}
  .mreg.flat{color:var(--amber);border-color:color-mix(in srgb,var(--amber) 30%,transparent);background:color-mix(in srgb,var(--amber) 8%,transparent)}
  .mreg .paused{color:var(--r);font-weight:700}
  .mreg .active{color:var(--g);font-weight:700}
  .pacct{padding:16px 0;border-top:1px solid var(--line)}
  .pacct:first-child{border-top:none;padding-top:2px}
  .pacct-h{margin-bottom:10px}
  .pbadge{font-size:11px;font-weight:700;letter-spacing:.4px;padding:4px 10px;border-radius:6px;border:1px solid var(--line)}
  .pbadge.filt{color:var(--r);border-color:color-mix(in srgb,var(--r) 34%,transparent);background:color-mix(in srgb,var(--r) 8%,transparent)}
  .pbadge.all{color:var(--amber);border-color:color-mix(in srgb,var(--amber) 34%,transparent);background:color-mix(in srgb,var(--amber) 8%,transparent)}
  .pdiv{height:2px}
  /* paper-account stat grid — hairline-separated metric cells (premium, not a run-on mono line) */
  .pstats{display:grid;grid-template-columns:repeat(auto-fit,minmax(84px,1fr));gap:1px;margin-top:16px;background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden;box-shadow:var(--inset)}
  .pstat{background:linear-gradient(180deg,var(--surface),var(--surface2));padding:10px 13px}
  .pstat .k{font-size:9.5px;letter-spacing:.5px;text-transform:uppercase;color:var(--dim);font-weight:600;white-space:nowrap}
  .pstat .v{font-family:var(--font);font-size:15px;font-weight:600;color:var(--text);margin-top:4px;font-feature-settings:'tnum' 1,'zero' 1}
  .btn{display:inline-flex;align-items:center;gap:6px;font-family:var(--font);font-size:12.5px;font-weight:550;
    color:var(--muted);background:linear-gradient(180deg,var(--surface),var(--surface2));border:1px solid var(--line);border-radius:9px;
    padding:6px 11px;cursor:pointer;box-shadow:var(--inset);transition:background .2s var(--ease),border-color .2s var(--ease),color .2s var(--ease),transform .12s var(--ease)}
  .btn:hover{background:var(--hover);border-color:var(--line2);color:var(--text)}
  .btn:active{transform:translateY(1px)}
  .btn.icon{padding:6px}
  .btn.xs{padding:3px 9px;font-size:11px}
  .btn svg{display:block}

  /* cards */
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
  .card{background:linear-gradient(180deg,var(--surface),var(--surface2));border:1px solid var(--line);border-radius:var(--radius);padding:18px;
    box-shadow:var(--shadow),var(--inset);transition:border-color .25s var(--ease),transform .25s var(--ease),box-shadow .25s var(--ease)}
  .card:hover{border-color:var(--line2);transform:translateY(-2px);box-shadow:var(--shadow-lg),var(--inset)}
  /* first-load skeletons — shown until the first scan/poll fills real content */
  .skcard{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px;box-shadow:var(--shadow)}
  .skb{height:13px;border-radius:6px;background:var(--chipbg);position:relative;overflow:hidden}
  .skb::after{content:'';position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--text) 7%,transparent),transparent);animation:shimmer 1.3s ease-in-out infinite}
  @keyframes shimmer{100%{transform:translateX(100%)}}
  .crow{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .sym{font-size:14px;font-weight:600;letter-spacing:.2px;color:var(--text)}
  .tf{color:var(--dim);font-family:var(--font);font-size:11px;margin-left:6px}
  .price{font-family:var(--font);font-size:31px;font-weight:600;letter-spacing:-.6px;margin:12px 0 0;color:var(--text);font-feature-settings:'tnum' 1,'zero' 1}
  .dist{display:flex;gap:6px;margin-top:6px;font-family:var(--font)}
  .coin{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;
    font-size:12px;font-weight:600;color:var(--text);background:var(--chipbg);border:1px solid var(--line);margin-right:8px;vertical-align:-4px}

  .chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;font-family:var(--font);white-space:nowrap}
  .chip.up{color:var(--g);background:color-mix(in srgb,var(--g) 12%,transparent)}
  .chip.down{color:var(--r);background:color-mix(in srgb,var(--r) 12%,transparent)}
  .chip.neutral{color:var(--muted);background:var(--chipbg)}
  .chip.warn{color:var(--amber);background:color-mix(in srgb,var(--amber) 14%,transparent)}
  .reg{font-family:var(--font);font-size:10px;text-transform:uppercase;letter-spacing:.6px;padding:2px 7px;border-radius:5px;color:var(--muted);background:var(--chipbg);white-space:nowrap}
  .reg.uptrend{color:var(--g);background:color-mix(in srgb,var(--g) 10%,transparent)}
  .reg.downtrend{color:var(--r);background:color-mix(in srgb,var(--r) 10%,transparent)}
  .reg.volatile{color:var(--amber);background:color-mix(in srgb,var(--amber) 12%,transparent)}
  .reg.ranging{color:var(--muted);background:var(--chipbg)}
  /* multi-timeframe trend strip (zoom in / zoom out) */
  .mtf{display:flex;gap:5px;margin-top:13px}
  .mtfc{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;padding:5px 2px;border-radius:7px;background:var(--chipbg);border:1px solid transparent}
  .mtft{font-size:9px;text-transform:uppercase;letter-spacing:.4px;color:var(--dim);font-weight:600}
  .mtfa{font-size:12px;font-weight:700;line-height:1}
  .mtfc.up{background:color-mix(in srgb,var(--g) 12%,transparent);border-color:color-mix(in srgb,var(--g) 22%,transparent)}
  .mtfc.up .mtfa{color:var(--g)}
  .mtfc.down{background:color-mix(in srgb,var(--r) 12%,transparent);border-color:color-mix(in srgb,var(--r) 22%,transparent)}
  .mtfc.down .mtfa{color:var(--r)}
  .mtfc.flat .mtfa{color:var(--muted)}
  .coin{flex:none}
  .board{display:flex;flex-wrap:wrap;gap:10px}
  .stile{flex:1;min-width:250px;border:1px solid var(--line);border-left-width:3px;border-radius:10px;padding:13px 16px;background:linear-gradient(180deg,var(--surface),var(--surface2));box-shadow:var(--shadow),var(--inset);transition:transform .2s var(--ease),border-color .2s var(--ease)}
  .stile:hover{transform:translateY(-1px);border-color:var(--line2)}
  .stile.LONG{border-left-color:var(--g)} .stile.SHORT{border-left-color:var(--r)} .stile.WATCH{border-left-color:var(--line2)}
  .stile .d{font-weight:600;font-size:13px;letter-spacing:.2px}
  .stile.LONG .d{color:var(--g)} .stile.SHORT .d{color:var(--r)} .stile.WATCH .d{color:var(--muted)}

  /* signal badge */
  .signal{font-weight:600;font-size:13px;letter-spacing:.3px;padding:8px 14px;border-radius:9px;text-align:center;border:1px solid var(--line);min-width:100px;color:var(--muted);background:linear-gradient(180deg,var(--surface),var(--surface2));box-shadow:var(--inset)}
  .signal.LONG{color:var(--g);border-color:color-mix(in srgb,var(--g) 34%,transparent);background:color-mix(in srgb,var(--g) 8%,transparent)}
  .signal.SHORT{color:var(--r);border-color:color-mix(in srgb,var(--r) 34%,transparent);background:color-mix(in srgb,var(--r) 8%,transparent)}
  .signal.WAIT{color:var(--muted)}
  .signal.wLONG{color:var(--g);border-color:color-mix(in srgb,var(--g) 20%,transparent)}
  .signal.wSHORT{color:var(--r);border-color:color-mix(in srgb,var(--r) 20%,transparent)}
  .signal small{display:block;font-size:9.5px;font-weight:500;letter-spacing:0;opacity:.72;margin-top:2px;text-transform:none;color:var(--muted)}

  /* meter */
  .meter{position:relative;height:6px;border-radius:4px;margin:20px 0 8px;background:var(--line)}
  .meter .mk{position:absolute;top:50%;width:2px;height:14px;border-radius:2px;background:var(--accent);transform:translate(-50%,-50%)}
  .meter .mkl{position:absolute;top:-18px;transform:translateX(-50%);font-family:var(--font);font-size:11px;font-weight:600;color:var(--text);white-space:nowrap}
  .mlab{display:flex;justify-content:space-between;font-family:var(--font);font-size:11.5px}
  .mlab .s{color:var(--g)} .mlab .r{color:var(--r)}
  .status{width:6px;height:6px;border-radius:50%;display:inline-block;margin:0 4px;vertical-align:middle;background:var(--dim)}
  .status.on{background:var(--g)} .status.off{background:var(--dim)}
  .tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px;padding-top:13px;border-top:1px solid var(--line);font-size:10.5px;font-family:var(--font)}
  .tags .t{color:var(--muted);background:var(--chipbg);padding:3px 8px;border-radius:6px;white-space:nowrap}
  .tags .t.g{color:var(--g);background:color-mix(in srgb,var(--g) 10%,transparent)}
  .tags .t.r{color:var(--r);background:color-mix(in srgb,var(--r) 10%,transparent)}
  .tags .t.a{color:var(--amber);background:color-mix(in srgb,var(--amber) 12%,transparent)}

  /* panels */
  .panel{margin-top:20px;background:linear-gradient(180deg,var(--surface),var(--surface2));border:1px solid var(--line);border-radius:var(--radius);padding:24px 26px;box-shadow:var(--shadow),var(--inset)}
  .panel h2{font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted);margin:0 0 5px;font-weight:600}
  .panel>h2{display:flex;align-items:center;gap:9px}
  .panel>h2::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--lux);box-shadow:0 0 8px color-mix(in srgb,var(--lux) 60%,transparent);flex:none}
  .panel .sub{color:var(--dim);font-size:12px;margin:0 0 16px;max-width:820px;line-height:1.55}
  .big{font-family:var(--font);font-size:30px;font-weight:600;letter-spacing:-.5px;color:var(--text);font-feature-settings:'tnum' 1,'zero' 1}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th{text-align:left;color:var(--dim);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.8px;padding:7px 10px 10px;border-bottom:1px solid var(--line2)}
  td{padding:11px 10px;border-bottom:1px solid var(--line);font-family:var(--font);color:var(--text);font-feature-settings:'tnum' 1,'zero' 1;transition:background .12s var(--ease)}
  tbody tr:hover td{background:var(--hover)}
  td.name{font-family:var(--font);font-weight:500}
  tr:last-child td{border-bottom:none}
  .pos{color:var(--g)} .neg{color:var(--r)} .muted{color:var(--muted)}
  .edgebar{display:inline-block;height:5px;border-radius:3px;vertical-align:middle;margin-left:8px}
  code{font-family:var(--font);font-size:11px;background:var(--chipbg);padding:1px 5px;border-radius:4px}

  .alert{border-left:2px solid var(--line2);padding:11px 14px;margin-bottom:8px;background:var(--surface2);border-radius:0 8px 8px 0}
  .alert.support,.alert.long{border-left-color:var(--g)} .alert.resistance,.alert.short{border-left-color:var(--r)}
  .alert .ah{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
  .alert .ab{font-weight:600;font-size:12.5px;font-family:var(--font);color:var(--text)}
  .alert .facs{margin-top:5px;font-size:12px;color:var(--muted)}
  .ok{color:var(--g)} .no{color:var(--dim)}
  .grade-STRONG{color:var(--g)} .grade-OK{color:var(--amber)} .grade-WEAK{color:var(--r)}
  .bet{margin-top:7px;font-size:12px}
  .bgrade{display:inline-block;font-family:var(--font);font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px;letter-spacing:.6px;margin-right:7px}
  .b-STRONG{color:var(--g);background:color-mix(in srgb,var(--g) 15%,transparent)}
  .b-OK{color:var(--amber);background:color-mix(in srgb,var(--amber) 15%,transparent)}
  .b-WEAK{color:var(--muted);background:var(--chipbg)}
  .b-AVOID{color:var(--r);background:color-mix(in srgb,var(--r) 15%,transparent)}
  .empty{color:var(--dim);font-size:13px}
  #config table{width:100%;white-space:normal;display:table}
  #config td{padding:5px 0}
  #config td:first-child{width:1%;padding-right:16px}
  .oc{font-size:11px;font-weight:700;padding:1px 6px;border-radius:5px;letter-spacing:.3px}
  .oc.win{color:var(--g);background:color-mix(in srgb,var(--g) 15%,transparent)}
  .oc.lost{color:var(--r);background:color-mix(in srgb,var(--r) 15%,transparent)}
  .oc.open{color:var(--muted);background:var(--chipbg)}
  /* tabbed navigation — enterprise multi-view */
  .tabs{display:flex;gap:4px;margin:0 0 22px;padding:4px;background:linear-gradient(180deg,var(--surface),var(--surface2));border:1px solid var(--line);border-radius:12px;box-shadow:var(--inset);position:sticky;top:8px;z-index:30;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
  .tab{flex:0 0 auto;appearance:none;border:0;background:transparent;color:var(--muted);font-family:var(--font);font-size:13px;font-weight:600;letter-spacing:.2px;padding:8px 18px;border-radius:9px;cursor:pointer;transition:color .16s var(--ease),background .16s var(--ease)}
  .tab:hover{color:var(--text)}
  .tab.active{color:var(--text);background:linear-gradient(180deg,color-mix(in srgb,var(--accent) 20%,transparent),color-mix(in srgb,var(--accent) 8%,transparent));box-shadow:var(--inset)}
  [data-tab][hidden]{display:none!important}
  /* demo / real mode switch (view only — never places live orders) */
  .modesw{display:inline-flex;border:1px solid var(--line);border-radius:9px;overflow:hidden;background:var(--surface2)}
  .modeb{appearance:none;border:0;background:transparent;color:var(--dim);font-family:var(--font);font-size:11px;font-weight:700;letter-spacing:.5px;padding:6px 11px;cursor:pointer;transition:color .15s var(--ease),background .15s var(--ease)}
  .modeb:hover{color:var(--text)}
  .modeb.on[data-mode-btn=demo]{color:var(--g);background:color-mix(in srgb,var(--g) 15%,transparent)}
  .modeb.on[data-mode-btn=real]{color:var(--amber);background:color-mix(in srgb,var(--amber) 16%,transparent)}
  :root[data-mode=demo] .demo-book{box-shadow:var(--shadow),var(--inset),inset 3px 0 0 var(--g)}
  :root[data-mode=real] .real-book{box-shadow:var(--shadow),var(--inset),inset 3px 0 0 var(--amber)}
  .modetag{font-size:9px;font-weight:700;letter-spacing:.5px;padding:2px 6px;border-radius:5px;margin-left:8px;vertical-align:middle}
  .modetag.demo{color:var(--g);background:color-mix(in srgb,var(--g) 14%,transparent)}
  .modetag.real{color:var(--amber);background:color-mix(in srgb,var(--amber) 15%,transparent)}
  .tslg{vertical-align:middle}
  /* P&L analysis tab */
  .pnltoggle{display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap}
  .ptg{appearance:none;border:1px solid var(--line);background:var(--surface2);color:var(--muted);font-family:var(--font);font-size:12px;font-weight:600;padding:5px 12px;border-radius:8px;cursor:pointer;transition:color .15s var(--ease),border-color .15s var(--ease),background .15s var(--ease)}
  .ptg:hover{color:var(--text)}
  .ptg.on{color:var(--text);border-color:color-mix(in srgb,var(--accent) 50%,var(--line));background:color-mix(in srgb,var(--accent) 12%,transparent)}
  .pnlcards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:22px}
  .pnlcard{background:linear-gradient(180deg,var(--surface),var(--surface2));border:1px solid var(--line);border-radius:12px;padding:14px 16px;box-shadow:var(--inset)}
  .pck{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim);font-weight:600}
  .pcval{font-size:23px;font-weight:700;margin-top:6px;font-feature-settings:'tnum' 1,'zero' 1}
  .pcs{font-size:11px;margin-top:3px}
  .pnlgrid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}
  @media(max-width:820px){.pnlgrid{grid-template-columns:1fr}}
  .ph{font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin:0 0 12px;font-weight:600}
  .cal{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--surface2)}
  .calh,.calg{display:grid;grid-template-columns:repeat(7,1fr)}
  .cdow{padding:8px 0;text-align:center;font-size:10px;color:var(--dim);font-weight:600;text-transform:uppercase;border-bottom:1px solid var(--line)}
  .cday{min-height:50px;padding:6px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);display:flex;flex-direction:column;justify-content:space-between}
  .cday:nth-child(7n){border-right:0}
  .cday.pad{background:transparent}
  .cdn{font-size:11px;color:var(--muted)}
  .cdv{font-size:10.5px;font-weight:700;font-feature-settings:'tnum' 1}
  .cday.pos{background:color-mix(in srgb,var(--g) 15%,transparent)}
  .cday.pos .cdv{color:var(--g)}
  .cday.neg{background:color-mix(in srgb,var(--r) 15%,transparent)}
  .cday.neg .cdv{color:var(--r)}
  .pcurve{display:block;width:100%;height:120px;background:var(--surface2);border:1px solid var(--line);border-radius:12px}
  .pcurve.empty{display:flex;align-items:center;justify-content:center;color:var(--dim);font-size:12px}
  .arow{display:grid;grid-template-columns:52px 1fr 80px 28px;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);font-size:12px;font-feature-settings:'tnum' 1}
  .arow:last-child{border-bottom:0}
  .asym{font-weight:600}
  .abar{height:8px;background:var(--chipbg);border-radius:4px;overflow:hidden}
  .afill{height:100%;border-radius:4px}
  .afill.pos{background:var(--g)}
  .afill.neg{background:var(--r)}
  /* manual trade log */
  .mform{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;align-items:center}
  .mform input,.mform select{font-family:var(--font);font-size:12.5px;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--surface2);color:var(--text);outline:none;transition:border-color .15s var(--ease)}
  .mform input:focus,.mform select:focus{border-color:color-mix(in srgb,var(--accent) 55%,var(--line))}
  .mform input::placeholder{color:var(--dim)}
  .mform input[name=symbol]{width:128px;text-transform:uppercase;font-weight:600}
  .mform input[type=number]{width:100px}
  .mform input[name=note]{flex:1;min-width:120px}
  .msum{display:flex;flex-wrap:wrap;gap:18px;margin-bottom:12px;font-size:12.5px;color:var(--muted)}
  .msum b{color:var(--text);font-weight:600}

  /* responsive / mobile — the dashboard is an installable PWA, so it must hold up on a phone */
  @media (max-width:680px){
    .wrap{padding:14px 12px 64px}
    .cards{grid-template-columns:1fr;gap:12px}
    .panel{padding:16px 14px}
    .panel table{display:block;overflow-x:auto;white-space:nowrap;-webkit-overflow-scrolling:touch}
    .top{margin-bottom:16px;padding-bottom:12px}
    .brand{font-size:14px}
    .price{font-size:26px}
    .big{font-size:24px}
    .board{gap:8px}
    .stile{min-width:0;flex-basis:100%}
  }
</style></head>
<body><div class="wrap">
  <div id="connbanner" class="connbanner">⚠ connection lost — retrying… (the bot may be restarting)</div>
  <div class="top">
    <div class="brand"><span class="live"></span><svg class="logo" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg><span>Futures&nbsp;Bot</span></div>
    <div class="mbias MIXED" id="mbias">Market · —</div>
    <div class="mreg flat" id="mreg" title="Broad-market regime (trailing 7-day basket trend). The bot's measured edge is in downtrends — enable config.strategies.marketRegimeFilter to trade only then."></div>
    <div class="toolbar">
      <div class="stats" id="stats"><span class="muted">connecting…</span></div>
      <div class="modesw" title="DEMO = the bot's paper simulation.  REAL = your own manually-logged trades.  This only switches the view — it never places live orders.">
        <button class="modeb" data-mode-btn="demo" onclick="setMode('demo')">DEMO</button>
        <button class="modeb" data-mode-btn="real" onclick="setMode('real')">REAL</button>
      </div>
      <button class="btn icon" id="themeBtn" onclick="toggleTheme()" title="Toggle theme" aria-label="Toggle theme"></button>
      <button class="btn" onclick="testNotify()" title="Send a test notification"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg><span>Test</span></button>
      <a class="btn" href="/app" title="Open the new React Native app (one codebase — web + iOS + Android)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/></svg><span>New&nbsp;App</span></a>
    </div>
  </div>

  <nav class="tabs">
    <button class="tab active" data-tabbtn="overview" onclick="showTab('overview')">Overview</button>
    <button class="tab" data-tabbtn="trade" onclick="showTab('trade')">Trade</button>
    <button class="tab" data-tabbtn="journal" onclick="showTab('journal')">Journal</button>
    <button class="tab" data-tabbtn="pnl" onclick="showTab('pnl')">P&amp;L</button>
    <button class="tab" data-tabbtn="research" onclick="showTab('research')">Research</button>
  </nav>

  <div class="cards" id="cards" data-tab="overview"><div class="skcard"><div class="skb" style="width:38%;height:15px;margin-bottom:16px"></div><div class="skb" style="width:55%;height:26px;margin-bottom:18px"></div><div class="skb" style="width:100%;margin-bottom:10px"></div><div class="skb" style="width:72%"></div></div><div class="skcard"><div class="skb" style="width:38%;height:15px;margin-bottom:16px"></div><div class="skb" style="width:55%;height:26px;margin-bottom:18px"></div><div class="skb" style="width:100%;margin-bottom:10px"></div><div class="skb" style="width:72%"></div></div><div class="skcard"><div class="skb" style="width:38%;height:15px;margin-bottom:16px"></div><div class="skb" style="width:55%;height:26px;margin-bottom:18px"></div><div class="skb" style="width:100%;margin-bottom:10px"></div><div class="skb" style="width:72%"></div></div></div>

  <div class="panel demo-book" data-tab="overview">
    <h2>PAPER ACCOUNT · FAKE-MONEY TRACK RECORD <span class="modetag demo">DEMO</span></h2>
    <p class="sub">TWO accounts run the same signals side-by-side so the live records settle whether the filter helps: <b>FILTERED</b> only opens in a downtrend (the measured-best, risk-controlled config); <b>ALL SIGNALS</b> takes every setup in every regime (your strategy, unfiltered). Each sizes off its own compounding balance. Proof-of-profit before real capital; a taker fee is modeled, funding/slippage are not.</p>
    <div id="paper"><span class="empty">loading paper account…</span></div>
  </div>

  <div class="panel" data-tab="trade">
    <h2>SIGNALS · CLEAR LONG / SHORT CALLS</h2>
    <p class="sub">Each pair's current actionable read at a glance. A bright call = price is at/near the level now; "watch" = the nearest play and how far price must move to arm it.</p>
    <div id="board" class="board"><span class="empty">…</span></div>
  </div>

  <div class="panel" data-tab="trade">
    <h2>BOT POSITIONS · LIVE</h2>
    <p class="sub">The bot's open paper positions across both accounts — live TP/SL gauge, partial-take-profit status (½TP), and one-click close.</p>
    <div id="tradepos"><span class="empty">no open positions</span></div>
  </div>

  <div class="panel" data-tab="journal">
    <h2>LIVE TRACK RECORD</h2>
    <p class="sub">Every setup the bot flags is logged here and auto-graded win/loss against what price actually did next — your real hit rate as signals fire.</p>
    <div id="journal"><span class="empty">no trades logged yet — the market has to give a setup first</span></div>
  </div>

  <div class="panel" data-tab="pnl">
    <h2>P&amp;L ANALYSIS · REALIZED FAKE-MONEY</h2>
    <p class="sub">Booked profit/loss over time — daily calendar, cumulative curve, and per-asset breakdown. Fills in as positions close; with partial take-profit ON, each skim books realized P&amp;L here.</p>
    <div id="pnl"><span class="empty">no closed trades yet — this populates as positions close</span></div>
  </div>

  <div class="panel" data-tab="research">
    <h2>BACKTEST · WHICH SIGNALS ACTUALLY WORK <span id="btsym" class="muted" style="font-family:var(--font);letter-spacing:0"></span></h2>
    <p class="sub">Replayed recent history. For each signal factor: the win rate <b>when it was present</b> vs when it wasn't. <b>Improvement</b> = how many percentage points it added — <span class="pos">positive</span> means the factor helps, <span class="neg">negative</span> means it actually hurt.</p>
    <div id="bt"><span class="empty">run <code>npm run backtest</code> to populate</span></div>
  </div>

  <div class="panel" data-tab="research">
    <h2>LIQUIDITY SWEEPS</h2>
    <p class="sub">Price wicked past a swing level then closed back — a stop-hunt / liquidity grab. Bullish = swept a low & reclaimed (reversal up); bearish = swept a high & rejected. Timestamped.</p>
    <div id="sweeps"><span class="empty">no sweeps logged yet</span></div>
  </div>

  <div class="panel" data-tab="research">
    <h2>FAILED BREAKOUTS · REVERSALS</h2>
    <p class="sub">Price broke OUT of the range then closed back INSIDE — a trapped breakout. Bull trap = broke resistance then reclaimed (fade SHORT); bear trap = broke support then reclaimed (fade LONG). Each fires a reversal alert + plan.</p>
    <div id="reversals"><span class="empty">no failed breakouts logged yet</span></div>
  </div>

  <div class="panel" data-tab="research">
    <h2>SPOOF WATCH · FAKE WALLS PULLED</h2>
    <p class="sub">Big limit orders that appeared near price then vanished without trading — likely fake pressure. Logged with the time it was detected.</p>
    <div id="spoof"><span class="empty">no spoofing logged yet</span></div>
  </div>

  <div class="panel" data-tab="trade">
    <h2>SETUPS &amp; ALERTS · FULL PLANS</h2>
    <p class="sub">Every setup as it fires — touch / confirmation / breakout / strategy — each with its confluence score and a complete trade plan (entry · stop · TP1/2/3 · R:R · size).</p>
    <div id="alerts"><span class="empty">no alerts yet — waiting for a setup</span></div>
  </div>

  <div class="panel real-book" data-tab="trade">
    <h2>MY TRADES · MANUAL LOG <span class="modetag real">REAL</span></h2>
    <p class="sub">Record your OWN real trades here — the bot does not place them. Open trades mark to the live price; close one to book its P&amp;L. Kept completely separate from the paper accounts.</p>
    <form class="mform" onsubmit="return addManual(event)">
      <input name="symbol" placeholder="SYMBOL" required>
      <select name="direction"><option>LONG</option><option>SHORT</option></select>
      <input name="entry" type="number" step="any" placeholder="entry" required>
      <input name="size" type="number" step="any" placeholder="size (units)" required>
      <input name="stop" type="number" step="any" placeholder="stop (opt)">
      <input name="target" type="number" step="any" placeholder="target (opt)">
      <input name="note" placeholder="note (opt)">
      <button type="submit" class="btn">Add trade</button>
    </form>
    <div id="manual"><span class="empty">no trades logged — add one above</span></div>
  </div>
  <div class="panel" data-tab="research">
    <h2>CONFIGURATION · THE RULES THIS BOT TRADES BY</h2>
    <p class="sub">Read-only snapshot of the live operating config — edit config.ts and restart to change. Credentials are never shown.</p>
    <div id="config"><span class="empty">loading configuration…</span></div>
  </div>
</div>

<script>
const $=(id)=>document.getElementById(id);
const fmt=(p)=>p>=1000?p.toFixed(1):p>=1?p.toFixed(2):p>=0.01?p.toFixed(4):p.toPrecision(4);
function showTab(name){
  var els=document.querySelectorAll('[data-tab]');
  for(var i=0;i<els.length;i++)els[i].hidden=els[i].getAttribute('data-tab')!==name;
  var tabs=document.querySelectorAll('.tab');
  for(var j=0;j<tabs.length;j++)tabs[j].classList.toggle('active',tabs[j].getAttribute('data-tabbtn')===name);
  try{if(location.hash.slice(1)!==name)history.replaceState(null,'','#'+name);}catch(e){}
}
(function(){var t=(location.hash||'').slice(1);if(['overview','trade','journal','pnl','research'].indexOf(t)<0)t='overview';showTab(t);})();
function setMode(m){try{localStorage.setItem('mode',m);}catch(e){}document.documentElement.setAttribute('data-mode',m);var bs=document.querySelectorAll('.modeb');for(var i=0;i<bs.length;i++)bs[i].classList.toggle('on',bs[i].getAttribute('data-mode-btn')===m);}
(function(){var m='demo';try{m=localStorage.getItem('mode')||'demo';}catch(e){}if(m!=='real')m='demo';setMode(m);})();
// Per-trade TP/SL gauge: red risk zone (stop→entry), green reward zone (entry→target), a needle at live price.
function tpsl(o){
  var e=+o.entry,s=+o.stop,t=+o.target,pr=+o.price||e;
  var lo=Math.min(s,e,t,pr),hi=Math.max(s,e,t,pr),rng=(hi-lo)||1;
  var W=188,H=30,pad=10,y=15,X=function(v){return (pad+((v-lo)/rng)*(W-2*pad));};
  var xs=X(s),xe=X(e),xt=X(t),xp=X(pr);
  var risk='<rect x="'+Math.min(xs,xe).toFixed(1)+'" y="'+(y-2.5)+'" width="'+Math.abs(xe-xs).toFixed(1)+'" height="5" rx="2.5" fill="var(--r)" opacity="0.32"/>';
  var rew='<rect x="'+Math.min(xe,xt).toFixed(1)+'" y="'+(y-2.5)+'" width="'+Math.abs(xt-xe).toFixed(1)+'" height="5" rx="2.5" fill="var(--g)" opacity="0.32"/>';
  var tick=function(x,c,lab){return '<line x1="'+x.toFixed(1)+'" y1="'+(y-5)+'" x2="'+x.toFixed(1)+'" y2="'+(y+5)+'" stroke="'+c+'" stroke-width="1.6"/>'+(lab?'<text x="'+x.toFixed(1)+'" y="'+(y+13)+'" fill="'+c+'" font-size="7.5" text-anchor="middle" style="font-family:var(--font)">'+lab+'</text>':'');};
  var price='<polygon points="'+xp.toFixed(1)+','+(y-5)+' '+(xp-3.5).toFixed(1)+','+(y-11)+' '+(xp+3.5).toFixed(1)+','+(y-11)+'" fill="var(--text)"/><line x1="'+xp.toFixed(1)+'" y1="'+(y-6)+'" x2="'+xp.toFixed(1)+'" y2="'+(y+6)+'" stroke="var(--text)" stroke-width="1.4"/>';
  return '<svg class="tslg" width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'">'+risk+rew+tick(xe,'var(--dim)','')+tick(xs,'var(--r)',o.beDone?'BE':'SL')+tick(xt,'var(--g)','TP')+price+'</svg>';
}
const clamp=(x)=>Math.max(0,Math.min(1,x));
const FN={flow:'Order flow',fvg:'Fair value gap',sweep:'Liquidity sweep','premium/discount':'Premium / Discount',structure:'Market structure',HTF:'Higher-timeframe trend'};
var ICO_MOON='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
var ICO_SUN='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
function applyTheme(t){document.documentElement.setAttribute('data-theme',t);try{localStorage.setItem('theme',t)}catch(e){}var b=document.getElementById('themeBtn');if(b)b.innerHTML=(t==='light'?ICO_MOON:ICO_SUN);}
function toggleTheme(){var cur=document.documentElement.getAttribute('data-theme')==='light'?'light':'dark';applyTheme(cur==='light'?'dark':'light');}
(function(){var t='dark';try{t=localStorage.getItem('theme')||'dark';}catch(e){}applyTheme(t);})();
function tIST(x){if(!x)return '—';try{return new Date(x).toLocaleTimeString('en-IN',{hour12:true,hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'Asia/Kolkata'});}catch(e){return '—';}}
function freshness(x){if(!x)return '';try{var s=Math.max(0,Math.round((Date.now()-new Date(x).getTime())/1000));var t=s<60?(s+'s'):s<3600?(Math.floor(s/60)+'m'):(Math.floor(s/3600)+'h');var c=s<45?'var(--g)':s<120?'var(--amber)':'var(--r)';return ' &middot; <span style="color:'+c+'" title="time since the last completed scan">'+t+' ago</span>';}catch(e){return '';}}
function dtIST(x){if(!x)return '—';try{return new Date(x).toLocaleString('en-IN',{hour12:true,day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'});}catch(e){return '—';}}
const COIN={BTC:'₿',ETH:'Ξ',SOL:'◎',BNB:'B',XRP:'✕',DOGE:'Ð'};
function coin(sym){var base=sym.replace(/USDT|USDC|USD|PERP/g,'');return '<span class="coin">'+(COIN[base]||base.slice(0,1))+'</span>';}

function meter(sy){
  const pos=sy.high>sy.low?clamp((sy.price-sy.low)/(sy.high-sy.low)):0.5;
  return '<div class="meter"><div class="mkl" style="left:'+(pos*100)+'%">'+fmt(sy.price)+'</div><div class="mk" style="left:'+(pos*100)+'%"></div></div>'+
    '<div class="mlab"><span class="s">S '+fmt(sy.low)+'<span class="status '+(sy.supArmed?'on':'off')+'"></span></span>'+
    '<span class="r"><span class="status '+(sy.resArmed?'on':'off')+'"></span>R '+fmt(sy.high)+'</span></div>';
}
function tags(sy){
  const t=['<span class="t">'+sy.levelMode+' levels</span>'];
  if(sy.spoof&&sy.spoof.suspected) t.push('<span class="t r">spoof · '+sy.spoof.note+'</span>');
  else if(sy.spoof&&sy.spoof.pulls>0) t.push('<span class="t a">spoofing · '+sy.spoof.pulls+' walls pulled</span>');
  (sy.divergences||[]).forEach(d=>t.push('<span class="t '+(d.indexOf('bullish')>=0?'g':'r')+'">'+d+'</span>'));
  if(sy.liq&&sy.liq.cascade) t.push('<span class="t a">'+sy.liq.note+'</span>');
  if(sy.ob&&sy.ob.bull) t.push('<span class="t g">bull OB '+fmt(sy.ob.bull.low)+'–'+fmt(sy.ob.bull.high)+'</span>');
  if(sy.ob&&sy.ob.bear) t.push('<span class="t r">bear OB '+fmt(sy.ob.bear.low)+'–'+fmt(sy.ob.bear.high)+'</span>');
  if(sy.sweep) t.push('<span class="t '+(sy.sweep.type==='bull'?'g':'r')+'">'+sy.sweep.type+' sweep '+fmt(sy.sweep.level)+'</span>');
  if(sy.vp) t.push('<span class="t">POC '+fmt(sy.vp.poc)+' · VA '+fmt(sy.vp.val)+'–'+fmt(sy.vp.vah)+'</span>');
  return '<div class="tags">'+t.join('')+'</div>';
}
function mtfStrip(sy){
  if(!sy.mtf||!sy.mtf.length)return '';
  var ar={up:'▲',down:'▼',flat:'→'};
  return '<div class="mtf">'+sy.mtf.map(function(m){return '<span class="mtfc '+m.dir+'" title="'+m.tf+' trend: '+m.dir+'"><span class="mtft">'+m.tf+'</span><span class="mtfa">'+(ar[m.dir]||'→')+'</span></span>';}).join('')+'</div>';
}
function card(sy){
  const reg=sy.regime?'<span class="reg '+sy.regime.regime+'">'+sy.regime.regime+'</span>':'';
  const badge=sy.consolidating?'<span class="chip neutral">RANGE '+sy.widthPct.toFixed(1)+'%</span>':'<span class="chip warn">TRENDING</span>';
  const b=sy.bias||{dir:'WAIT',reason:''};
  let sig;
  if(b.dir==='WAIT'){
    const toR=sy.toR||0,toS=sy.toS||0,long=toS<=toR,d=(long?toS:toR).toFixed(2);
    sig='<div class="signal '+(long?'wLONG':'wSHORT')+'">'+(long?'▲ LONG':'▼ SHORT')+'<small>watching · '+d+'% to '+(long?'support':'resistance')+'</small></div>';
  } else {
    sig='<div class="signal '+b.dir+'">'+b.dir+'<small>'+b.reason+'</small></div>';
  }
  return '<div class="card"><div class="crow"><div><span class="sym">'+coin(sy.symbol)+sy.symbol+'</span><span class="tf">'+sy.interval+'</span></div><div style="display:flex;gap:7px;align-items:center">'+reg+badge+'</div></div>'+
    '<div class="crow" style="align-items:flex-end;margin-top:2px"><div><div class="price">'+fmt(sy.price)+'</div><div class="dist"><span class="chip up">▲ '+(sy.toR||0).toFixed(2)+'%</span><span class="chip down">▼ '+(sy.toS||0).toFixed(2)+'%</span></div></div>'+sig+'</div>'+
    mtfStrip(sy)+meter(sy)+tags(sy)+'</div>';
}
function stile(y){
  var b=y.bias||{dir:'WAIT',reason:''};var toR=y.toR||0,toS=y.toS||0;var dir,detail,cls;
  if(b.dir==='LONG'){cls='LONG';dir='▲ LONG';detail='buy at support '+fmt(y.low)+' · '+toS.toFixed(2)+'% away';}
  else if(b.dir==='SHORT'){cls='SHORT';dir='▼ SHORT';detail='sell at resistance '+fmt(y.high)+' · '+toR.toFixed(2)+'% away';}
  else{var lng=toS<=toR;cls='WATCH';dir=lng?'▲ LONG · watch':'▼ SHORT · watch';detail=lng?('support '+fmt(y.low)+' · '+toS.toFixed(2)+'% away'):('resistance '+fmt(y.high)+' · '+toR.toFixed(2)+'% away');}
  return '<div class="stile '+cls+'"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span>'+coin(y.symbol)+'<b>'+y.symbol+'</b></span><span class="d">'+dir+'</span></div><div class="muted" style="font-size:12px;margin-top:5px">'+detail+'</div></div>';
}

var __connMiss=0,__connState=true;
function setConn(ok){ if(ok===__connState)return; __connState=ok; var d=document.querySelector('.live'); if(d){ d.classList.toggle('down',!ok); d.title=ok?'live — connected to bot':'disconnected — retrying'; } var b=document.getElementById('connbanner'); if(b) b.style.display=ok?'none':'block'; }
function connOk(){ __connMiss=0; setConn(true); }
function connFail(){ if(++__connMiss>=2) setConn(false); }
async function tick(){
  try{
    const s=window.__STATE__||await (await fetch('/api/state')).json();
    const syms=s.symbols||[];
    $('cards').innerHTML=syms.length?syms.map(card).join(''):'<span class="empty">waiting for first scan…</span>';
    $('board').innerHTML=syms.length?syms.map(stile).join(''):'<span class="empty">…</span>';
    let jr={}; try{ jr=window.__JRN__||await (await fetch('/api/journal')).json(); }catch(e){}
    const st=jr.stats||{}; const dec=(st.wins||0)+(st.losses||0);
    let lo=0,sh=0; for(const y of syms){var dd=y.bias?y.bias.dir:'WAIT'; if(dd==='LONG')lo++; else if(dd==='SHORT')sh++; else{((y.toS||0)<=(y.toR||0))?lo++:sh++;}}
    const mb=lo>sh?'BULLISH':sh>lo?'BEARISH':'MIXED'; var mbEl=$('mbias'); if(mbEl){mbEl.className='mbias '+mb;mbEl.textContent='MARKET · '+mb;}
    var mr=s.market; var mrEl=$('mreg');
    if(mrEl){ if(mr&&mr.regime){ mrEl.style.display='inline-block'; mrEl.className='mreg '+mr.regime;
      var allowed=mr.allowedRegimes||['bull','flat'];
      var status=mr.filterActive?(allowed.indexOf(mr.regime)>=0?' · <span class="active">entries active</span>':' · <span class="paused">entries paused</span>'):'';
      mrEl.innerHTML='REGIME · '+mr.regime.toUpperCase()+status; } else { mrEl.style.display='none'; } }
    $('stats').innerHTML='<span><b>'+syms.length+'</b> pairs</span><span><b>'+(st.open||0)+'</b> open</span>'+
      '<span><b>'+(dec?Math.round(st.winRate*100)+'%':'—')+'</b> win rate</span>'+
      '<span>updated <b>'+tIST(s.updatedAt)+'</b>'+freshness(s.updatedAt)+'</span>'+
      ((s.feeds&&s.feeds.length)?'<span>'+s.feeds.map(function(f){var c=f.state==='live'?'var(--g)':f.state==='off'?'var(--r)':'var(--amber)';return '<span style="color:'+c+'">●</span> '+(f.name==='liquidations'?'liq':f.name);}).join(' &nbsp; ')+'</span>':'')+
      '<span>'+(s.telegram?'📲 Telegram':'terminal')+'</span>';
    connOk();
  }catch(e){ connFail(); }
}
async function testNotify(){ try{ await fetch('/api/test-notify'); }catch(e){} if('Notification' in window){ if(Notification.permission==='granted') new Notification('AlertBot','Test alert ✅'); else Notification.requestPermission().then(p=>{if(p==='granted')new Notification('AlertBot','Test alert ✅')}); } }

function alertRow(a){
  const g=(a.score||'').split(' ')[1]||'';
  const dir=a.kind==='strategy'?(a.direction==='LONG'?'long':'short'):a.level;
  const head=a.kind==='strategy'?('🎯 '+(a.strategyName||'')+' '+(a.direction||'')):(a.kind.toUpperCase()+' · '+a.level);
  const facs=(a.factors||[]).map(f=>'<span class="'+(f.ok?'ok':'no')+'">'+(f.ok?'✓':'✗')+' '+f.label+'</span>').join(' &nbsp; ');
  const ctx=(a.context||[]).length?'<div class="facs">'+a.context.join(' · ')+'</div>':'';
  const p=a.plan; const pl=p?'<div class="facs" style="color:var(--text);margin-top:6px"><b>'+p.direction+'</b> · entry '+fmt(p.entry)+' · stop '+fmt(p.stop)+' · target '+fmt(p.target)+' · TP '+fmt(p.tp1)+' / '+fmt(p.tp2)+' / '+fmt(p.tp3)+' · R:R '+p.rr.toFixed(2)+(p.lowQuality?' <span class="neg">⚠</span>':'')+' · '+p.sizeUnits.toFixed(3)+' (~$'+Math.round(p.notionalUsd)+', '+p.leverage.toFixed(1)+'x)</div>':'';
  var bt=a.bet; var betHtml='';
  if(bt){
    var on=(bt.workers||[]).filter(function(w){return w.present;}).map(function(w){return '<span class="ok">'+w.name+' '+(w.liftPp>=0?'+':'')+w.liftPp.toFixed(0)+'pp</span>';}).join(' ');
    betHtml='<div class="bet"><span class="bgrade b-'+bt.grade+'">'+bt.grade+'</span><b>~'+bt.winPct.toFixed(0)+'% win</b>'+(bt.measuredExpR!=null?' <span class="muted">· '+(bt.measuredExpR>=0?'+':'')+bt.measuredExpR.toFixed(2)+'R over '+bt.sampleN+' trades</span>':'')+(on?'<div style="margin-top:3px">'+on+'</div>':'')+'</div>';
  }
  var oc=a.outcome==='win'?'<span class="oc win">✓ WON</span> ':a.outcome==='loss'?'<span class="oc lost">✗ LOST</span> ':(a.signalCloseTime?'<span class="oc open">⋯ tracking</span> ':'');
  return '<div class="alert '+dir+'"><div class="ah"><span class="ab">'+a.symbol+' · '+head+' @ '+fmt(a.levelPrice)+'</span><span class="muted">'+oc+tIST(a.time)+' <b class="grade-'+g+'">'+(a.score||'')+'</b></span></div><div class="facs">'+a.message+'</div>'+betHtml+(facs?'<div class="facs">'+facs+'</div>':'')+ctx+pl+'</div>';
}
async function loadAlerts(){ try{ const s=window.__STATE__||await (await fetch('/api/state')).json(); if(s.alerts&&s.alerts.length)$('alerts').innerHTML=s.alerts.map(alertRow).join(''); }catch(e){} }

async function loadJournal(){
  try{ const j=window.__JRN__||await (await fetch('/api/journal')).json(); if(!j||!j.stats)return; const s=j.stats; const dec=s.wins+s.losses;
    let h='<div class="big '+(dec?(s.winRate>=0.5?'pos':'neg'):'')+'">'+(dec?(s.winRate*100).toFixed(0)+'%':'—')+'</div><span class="muted">win rate · '+s.wins+' wins / '+s.losses+' losses · '+s.open+' open</span>';
    if(j.bySource&&Object.keys(j.bySource).length){
      h+='<table style="margin-top:12px"><tr><th>signal type</th><th>signals</th><th>wins / losses</th><th>accuracy</th></tr>';
      var keys=Object.keys(j.bySource).sort();
      for(var ki=0;ki<keys.length;ki++){var k=keys[ki],gg=j.bySource[k],dd2=gg.wins+gg.losses;
        h+='<tr><td class="name">'+k+'</td><td class="muted">'+gg.total+'</td><td class="muted">'+gg.wins+' / '+gg.losses+(gg.open?' · '+gg.open+' open':'')+'</td><td class="'+(dd2?(gg.winRate>=0.5?'pos':'neg'):'muted')+'">'+(dd2?(gg.winRate*100).toFixed(0)+'%':'—')+'</td></tr>';}
      h+='</table>';
    }
    if((j.entries||[]).length){ h+='<table style="margin-top:12px"><tr><th>time</th><th>symbol</th><th>direction</th><th>signal type</th><th>entry → target</th><th>risk:reward</th><th>result</th></tr>';
      for(const e of j.entries){const c=e.status==='win'?'pos':e.status==='loss'?'neg':'muted';
        h+='<tr><td class="muted">'+dtIST(e.time)+'</td><td>'+e.symbol+'</td><td>'+e.direction+'</td><td class="name">'+(e.level||'—')+'</td><td class="muted">'+fmt(e.entry)+' → '+fmt(e.target)+'</td><td>'+(e.rr||0).toFixed(1)+'</td><td class="'+c+'">'+e.status.toUpperCase()+'</td></tr>';}
      h+='</table>'; }
    $('journal').innerHTML=h;
  }catch(e){}
}
async function loadBacktest(){
  try{ const b=window.__BT__||await (await fetch('/api/backtest')).json(); if(!b||!b.totals)return; if(b.symbol)$('btsym').textContent='— '+b.symbol+' '+(b.interval||'');
    const t=b.totals; let h='<div class="big">'+(t.winRate*100).toFixed(1)+'%</div><span class="muted">overall win rate over '+t.signals+' historical setups</span>';
    if(b.tp)h+='<div style="margin-top:8px;font-size:12px">take-profit reached before stop (historical): <span class="pos">TP1 (1R) '+(b.tp.r1*100).toFixed(0)+'%</span> &nbsp; <span class="pos">TP2 (2R) '+(b.tp.r2*100).toFixed(0)+'%</span> &nbsp; <span class="pos">TP3 (3R) '+(b.tp.r3*100).toFixed(0)+'%</span></div>';
    const facs=['flow','fvg','sweep','premium/discount','structure','HTF']; const dec=(b.signals||[]).filter(s=>s.outcome!=='timeout');
    h+='<table style="margin-top:14px"><tr><th>Signal factor</th><th>Win rate when present</th><th>Improvement vs when absent</th></tr>';
    for(const f of facs){const w=dec.filter(s=>s.present[f]),wo=dec.filter(s=>!s.present[f]); const wr=a=>a.length?a.filter(s=>s.outcome==='win').length/a.length:0; if(!w.length||!wo.length)continue;
      const edge=(wr(w)-wr(wo))*100; const bw=Math.min(70,Math.abs(edge)*1.3);
      h+='<tr><td class="name">'+(FN[f]||f)+'</td><td class="muted">'+(wr(w)*100).toFixed(0)+'%  ·  '+w.length+' trades</td>'+
        '<td class="'+(edge>=0?'pos':'neg')+'">'+(edge>=0?'+':'')+edge.toFixed(1)+' points<span class="edgebar" style="width:'+bw+'px;background:'+(edge>=0?'var(--g)':'var(--r)')+'"></span></td></tr>';}
    h+='</table><p class="sub" style="margin:12px 0 0">“points” = percentage points of win rate. Example: <span class="pos">+23.8</span> means it won 23.8% more often when that factor agreed.</p>';
    $('bt').innerHTML=h;
  }catch(e){}
}

async function loadSpoof(){try{var l=await (await fetch('/api/spoof')).json();if(!Array.isArray(l)||!l.length)return;$('spoof').innerHTML='<table><tr><th>time (IST)</th><th>symbol</th><th>event</th></tr>'+l.map(function(e){return '<tr><td class="muted">'+tIST(e.time)+'</td><td>'+e.symbol+'</td><td class="neg">⚠ '+e.note+'</td></tr>';}).join('')+'</table>';}catch(e){}}
async function loadSweeps(){try{var l=await (await fetch('/api/sweeps')).json();if(!Array.isArray(l)||!l.length)return;$('sweeps').innerHTML='<table><tr><th>time (IST)</th><th>symbol</th><th>sweep</th><th>level</th></tr>'+l.map(function(e){var b=e.type==='bull';return '<tr><td class="muted">'+dtIST(e.time)+'</td><td>'+e.symbol+'</td><td class="'+(b?'pos':'neg')+'">💧 '+e.type+' sweep</td><td>'+fmt(e.level)+'</td></tr>';}).join('')+'</table>';}catch(e){}}
async function loadReversals(){try{var l=await (await fetch('/api/reversals')).json();if(!Array.isArray(l)||!l.length)return;$('reversals').innerHTML='<table><tr><th>time (IST)</th><th>symbol</th><th>reversal</th><th>level</th><th>after</th></tr>'+l.map(function(e){var lng=e.direction==='LONG';return '<tr><td class="muted">'+dtIST(e.time)+'</td><td>'+e.symbol+'</td><td class="'+(lng?'pos':'neg')+'">🔄 '+(lng?'bear trap → LONG':'bull trap → SHORT')+'</td><td>'+fmt(e.level)+'</td><td class="muted">'+e.barsAfter+' candles</td></tr>';}).join('')+'</table>';}catch(e){}}
function sparkline(curve,start){
  if(!curve||!curve.length)return '<div style="flex:1;min-width:120px"></div>';
  var vals=[start];for(var i=0;i<curve.length;i++)vals.push(curve[i].balance);
  var min=Math.min.apply(null,vals),max=Math.max.apply(null,vals),rng=(max-min)||1,W=180,H=46,pts='';
  for(var j=0;j<vals.length;j++){var x=(j/(vals.length-1||1))*W;var y=H-((vals[j]-min)/rng)*H;pts+=(j?' ':'')+x.toFixed(1)+','+y.toFixed(1);}
  var col=vals[vals.length-1]>=start?'var(--g)':'var(--r)';
  return '<div style="flex:1;min-width:'+W+'px"><svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none"><polyline points="'+pts+'" fill="none" stroke="'+col+'" stroke-width="2" stroke-linejoin="round"/></svg><div class="muted" style="font-size:10px;font-family:var(--font)">equity curve · '+curve.length+' trades</div></div>';
}
async function closePaper(id,account){ if(!confirm('Close this paper position now at market price?'))return; try{ await fetch('/api/paper/close',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,account:account})}); loadPaper(); }catch(e){} }
document.addEventListener('click',function(e){var b=(e.target&&e.target.closest)?e.target.closest('.closebtn'):null;if(b)closePaper(b.getAttribute('data-id'),b.getAttribute('data-account'));});
// ---- P&L analysis tab (Binance-style: cards + daily calendar + cumulative curve + asset performance) ----
var pnlState={acct:'strategy',ym:null};
function setPnlAcct(id){pnlState.acct=id;loadPnl();}
function calMove(d){var now=new Date();var ym=pnlState.ym||{y:now.getFullYear(),m:now.getMonth()};var m=ym.m+d,y=ym.y;if(m<0){m=11;y--;}if(m>11){m=0;y++;}pnlState.ym={y:y,m:m};loadPnl();}
function pmoney(v){return v>0?'+$'+v.toFixed(2):v<0?'-$'+Math.abs(v).toFixed(2):'$0.00';}
function pcls(v){return v>0?'pos':v<0?'neg':'muted';}
function pcard(k,v,c,sub){return '<div class="pnlcard"><div class="pck">'+k+'</div><div class="pcval '+c+'">'+v+'</div>'+(sub?'<div class="pcs muted">'+sub+'</div>':'')+'</div>';}
function calendarHtml(daily,ym){
  var dows=['Su','Mo','Tu','We','Th','Fr','Sa'];
  var startDow=new Date(ym.y,ym.m,1).getDay(),days=new Date(ym.y,ym.m+1,0).getDate();
  var h=dows.map(function(d){return '<div class="cdow">'+d+'</div>';}).join(''),g='';
  for(var i=0;i<startDow;i++)g+='<div class="cday pad"></div>';
  for(var d=1;d<=days;d++){
    var key=ym.y+'-'+String(ym.m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    var v=daily[key],c=v==null?'':v>0?'pos':v<0?'neg':'';
    g+='<div class="cday '+c+'"><span class="cdn">'+d+'</span>'+(v!=null?'<span class="cdv">'+(v>0?'+':'')+v.toFixed(2)+'</span>':'')+'</div>';
  }
  return '<div class="cal"><div class="calh">'+h+'</div><div class="calg">'+g+'</div></div>';
}
function pnlCurveHtml(curve){
  if(!curve||!curve.length)return '<div class="pcurve empty">no realized P&L yet — closed trades will draw the curve</div>';
  var vals=[0];for(var i=0;i<curve.length;i++)vals.push(curve[i].cum);
  var min=Math.min.apply(null,vals),max=Math.max.apply(null,vals),rng=(max-min)||1,W=520,H=120,pts='';
  for(var j=0;j<vals.length;j++){var x=(j/(vals.length-1||1))*W,y=H-((vals[j]-min)/rng)*H;pts+=(j?' ':'')+x.toFixed(1)+','+y.toFixed(1);}
  var last=vals[vals.length-1],col=last>=0?'var(--g)':'var(--r)',zeroY=(H-((0-min)/rng)*H).toFixed(1);
  return '<svg class="pcurve" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none"><line x1="0" y1="'+zeroY+'" x2="'+W+'" y2="'+zeroY+'" stroke="var(--line2)" stroke-width="1" stroke-dasharray="3 3"/><polyline points="'+pts+'" fill="none" stroke="'+col+'" stroke-width="2" stroke-linejoin="round"/></svg>';
}
async function loadPnl(){
  try{
    var p=await (await fetch('/api/pnl')).json();if(!p||!p.accounts||!p.accounts.length)return;
    var a=p.accounts.find(function(x){return x.id===pnlState.acct;})||p.accounts[0];
    var toggle=p.accounts.map(function(x){return '<button class="ptg'+(x.id===a.id?' on':'')+'" onclick="setPnlAcct(\\''+x.id+'\\')">'+x.label.split(' · ')[0]+'</button>';}).join('');
    var cards='<div class="pnlcards">'+
      pcard('Equity','$'+a.equity.toFixed(2),(a.equity>=a.startBalance?'pos':'neg'),(a.realizedPct>=0?'+':'')+a.realizedPct.toFixed(2)+'% realized · '+a.trades+' closed')+
      pcard("Today's P&L",pmoney(a.today),pcls(a.today),'')+
      pcard('7-day P&L',pmoney(a.pnl7d),pcls(a.pnl7d),'')+
      pcard('30-day P&L',pmoney(a.pnl30d),pcls(a.pnl30d),'')+
      '</div>';
    var now=new Date(),ym=pnlState.ym||{y:now.getFullYear(),m:now.getMonth()};
    var mlab=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][ym.m]+' '+ym.y;
    var cal='<div class="ph" style="display:flex;justify-content:space-between;align-items:center">Daily P&L <span><button class="ptg" onclick="calMove(-1)">‹</button> <span class="muted" style="font-size:11px">'+mlab+'</span> <button class="ptg" onclick="calMove(1)">›</button></span></div>'+calendarHtml(a.daily||{},ym);
    var assets=Object.keys(a.byAsset||{}),maxA=1;
    for(var k=0;k<assets.length;k++)maxA=Math.max(maxA,Math.abs(a.byAsset[assets[k]].pnl));
    var ap=assets.length?assets.map(function(s){var o=a.byAsset[s],w=(Math.abs(o.pnl)/maxA*100).toFixed(0);return '<div class="arow"><span class="asym">'+s.replace('USDT','')+'</span><div class="abar"><div class="afill '+pcls(o.pnl)+'" style="width:'+w+'%"></div></div><span class="'+pcls(o.pnl)+'">'+pmoney(o.pnl)+'</span><span class="muted">'+o.trades+'t</span></div>';}).join(''):'<span class="empty">no closed trades yet</span>';
    $('pnl').innerHTML='<div class="pnltoggle">'+toggle+'</div>'+cards+'<div class="pnlgrid"><div>'+cal+'</div><div><h3 class="ph">Total P&L</h3>'+pnlCurveHtml(a.curve)+'<h3 class="ph" style="margin-top:20px">Asset performance</h3>'+ap+'</div></div>';
  }catch(e){}
}
function renderAccount(a){
  const s=a.stats||{};const rc=a.returnPct>=0?'pos':'neg';const uc=a.unrealized>=0?'pos':'neg';
  var badge=a.applyFilter?'<span class="pbadge filt" title="only opens trades in a downtrend (bear-only filter)">FILTERED · bear-only</span>':'<span class="pbadge all" title="takes every signal in every regime — your strategy, unfiltered">ALL SIGNALS · unfiltered</span>';
  var h='<div class="pacct"><div class="pacct-h">'+badge+'</div>';
  h+='<div style="display:flex;gap:26px;flex-wrap:wrap;align-items:flex-end">';
  h+='<div><div class="big '+rc+'">$'+a.equity.toFixed(2)+'</div><span class="muted">equity · '+(a.returnPct>=0?'+':'')+a.returnPct.toFixed(2)+'% from $'+a.startBalance.toFixed(0)+'</span></div>';
  h+='<div><div class="big '+(a.realizedReturnPct>=0?'pos':'neg')+'" style="font-size:20px">$'+a.balance.toFixed(2)+'</div><span class="muted">realized · '+(a.realizedReturnPct>=0?'+':'')+a.realizedReturnPct.toFixed(2)+'%</span></div>';
  h+='<div><div class="big '+uc+'" style="font-size:20px">'+(a.unrealized>=0?'+':'')+'$'+a.unrealized.toFixed(2)+'</div><span class="muted">open P&L · '+s.openCount+' live</span></div>';
  h+=sparkline(a.curve,a.startBalance);
  h+='</div>';
  var st=function(k,v,c){return '<div class="pstat"><div class="k">'+k+'</div><div class="v '+(c||'')+'">'+v+'</div></div>';};
  h+='<div class="pstats">';
  h+=st('Trades',s.trades,'');
  h+=st('Open',s.openCount,(s.openCount?'':'muted'));
  h+=st('Win rate',(s.trades?s.winRate.toFixed(0)+'%':'—'),(s.trades?(s.winRate>=50?'pos':'neg'):''));
  h+=st('Won',s.wins,'pos');
  h+=st('Lost',s.losses,'neg');
  h+=st('Avg win','$'+s.avgWinUsd.toFixed(2),'pos');
  h+=st('Avg loss',(s.avgLossUsd>0?'-$':'$')+s.avgLossUsd.toFixed(2),'neg');
  h+=st('Profit factor',(s.profitFactor===null?(s.wins?'∞':'—'):s.profitFactor.toFixed(2)),'');
  h+=st('Max drawdown',(s.maxDrawdownPct>0?'-':'')+s.maxDrawdownPct.toFixed(1)+'%',(s.maxDrawdownPct>0?'neg':'muted'));
  h+='</div>';
  if((a.open||[]).length){
    h+='<h2 style="margin-top:14px;font-size:11px">OPEN POSITIONS</h2><table><tr><th>symbol</th><th>dir</th><th>signal</th><th>entry</th><th>stop / target</th><th>tp / sl</th><th>price</th><th>open P&L</th><th></th></tr>';
    for(const o of a.open){var oc=o.uPnlUsd>=0?'pos':'neg';var st=o.beDone?'<b class="pos">'+fmt(o.stop)+'</b> <span style="font-size:10px">BE</span>':fmt(o.stop);h+='<tr><td>'+o.symbol+'</td><td class="'+(o.direction==='LONG'?'pos':'neg')+'">'+o.direction+'</td><td class="name muted">'+o.source+'</td><td class="muted">'+fmt(o.entry)+'</td><td class="muted">'+st+' / '+fmt(o.target)+'</td><td>'+tpsl(o)+'</td><td>'+fmt(o.price)+'</td><td class="'+oc+'">'+(o.uPnlUsd>=0?'+':'')+'$'+o.uPnlUsd.toFixed(2)+' ('+(o.uR>=0?'+':'')+o.uR.toFixed(2)+'R)</td><td><button class="btn xs closebtn" data-id="'+o.id+'" data-account="'+a.id+'">Close</button></td></tr>';}
    h+='</table>';
  }
  if((a.closed||[]).length){
    h+='<h2 style="margin-top:14px;font-size:11px">RECENT CLOSED TRADES</h2><table><tr><th>closed</th><th>symbol</th><th>dir</th><th>signal</th><th>entry &rarr; exit</th><th>result</th><th>P&L</th><th>balance</th></tr>';
    for(const t of a.closed){var cc=t.pnlUsd>=0?'pos':'neg';h+='<tr><td class="muted">'+dtIST(t.closeTime)+'</td><td>'+t.symbol+'</td><td class="'+(t.direction==='LONG'?'pos':'neg')+'">'+t.direction+'</td><td class="name muted">'+t.source+'</td><td class="muted">'+fmt(t.entry)+' &rarr; '+fmt(t.exit)+'</td><td class="'+cc+'">'+t.exitReason.toUpperCase()+'</td><td class="'+cc+'">'+(t.pnlUsd>=0?'+':'')+'$'+t.pnlUsd.toFixed(2)+' ('+(t.rMultiple>=0?'+':'')+t.rMultiple.toFixed(2)+'R)</td><td class="muted">$'+t.balanceAfter.toFixed(2)+'</td></tr>';}
    h+='</table>';
  }
  if(!(a.open||[]).length&&!(a.closed||[]).length)h+='<p class="sub" style="margin-top:10px">No trades yet'+(a.applyFilter?' — this account waits for a downtrend before it opens anything.':' — opens on the next signal that fires.')+'</p>';
  h+='</div>';
  return h;
}
async function loadPaper(){
  try{
    const p=window.__PAPER__||await (await fetch('/api/paper')).json();
    if(!p)return;
    if(!p.enabled){$('paper').innerHTML='<span class="empty">Paper trading is disabled — set <b>paper.enabled</b> in config.ts and restart to track a fake-money record here.</span>';return;}
    var accs=p.accounts||[];
    if(!accs.length){$('paper').innerHTML='<span class="empty">no paper accounts</span>';return;}
    $('paper').innerHTML=accs.map(renderAccount).join('<div class="pdiv"></div>');
  }catch(e){}
}
async function loadConfig(){
  try{
    const c=window.__CFG__||await (await fetch('/api/config')).json();
    if(!c||!c.market)return;
    const SNAME={breakoutRetest:'breakout-retest',tsmom:'momentum (TSMOM)',bollinger:'bollinger-reversion',trendPullback:'trend-pullback',vwapReversion:'vwap-reversion',sweepReversal:'sweep-reversal',orderFlow:'order-flow'};
    const m=c.market,a=c.account,x=c.exit,r=c.consolidation,cw=c.confluenceWeights||{};
    const sep=' &nbsp;·&nbsp; ';
    const lv=m.levelMode==='manual'?('manual '+fmt(m.manualSupport)+'–'+fmt(m.manualResistance)):'auto range';
    const wk=Object.keys(cw).filter(function(k){return cw[k]>0;}).sort(function(p,q){return cw[q]-cw[p];});
    const strat=(c.strategies&&c.strategies.length)?c.strategies.map(function(k){return SNAME[k]||k;}).join(' · '):'—';
    const exitTxt=(x.breakevenAtR>0?('break-even at +'+x.breakevenAtR+'R'+(x.breakevenExclude&&x.breakevenExclude.length?(' (except '+x.breakevenExclude.join(', ')+')'):'')):'fixed stop / target')+(x.trailAtrMult>0?(sep+'trail '+x.trailAtrMult+'×ATR'):sep+'no trailing');
    const rows=[
      ['Market', m.watchlist.join(' · ')+sep+m.interval+sep+lv+sep+'scan '+m.pollIntervalSec+'s'],
      ['Account', '$'+a.startBalanceUsd+' start'+sep+a.riskPct+'% risk / trade'+sep+a.feeBps+'bps fee'+sep+a.slippageBps+'bps slippage'+sep+'max '+a.maxOpenPerSymbol+' / symbol'],
      ['Exit', exitTxt],
      ['Range', 'consolidation '+r.minRangeWidthPct+'–'+r.maxRangeWidthPct+'% wide'+sep+'touch within '+r.touchTolerancePct+'%'],
      ['Strategies', strat],
      ['Confluence', wk.length?wk.map(function(k){return k+' '+cw[k];}).join(' · '):'—'],
      ['Alerts', 'desktop ≥ '+c.notifyMinGrade+' grade'+sep+(c.telegramConfigured?'📲 Telegram on':'terminal only')]
    ];
    $('config').innerHTML='<table>'+rows.map(function(rw){return '<tr><td class="muted" style="white-space:nowrap;vertical-align:top;padding-right:14px">'+rw[0]+'</td><td>'+rw[1]+'</td></tr>';}).join('')+'</table>';
  }catch(e){}
}
if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function(){});
async function loadTradePos(){try{var p=await (await fetch('/api/paper')).json();if(!p||!p.accounts)return;var open=[];p.accounts.forEach(function(a){(a.open||[]).forEach(function(o){open.push(Object.assign({acct:a.label.split(' · ')[0],accid:a.id},o));});});if(!open.length){$('tradepos').innerHTML='<span class="empty">no open positions — the bot opens on the next qualifying signal</span>';return;}var rows=open.map(function(o){var oc=o.uPnlUsd>=0?'pos':'neg';var st=o.beDone?'<b class="pos">'+fmt(o.stop)+'</b> BE':fmt(o.stop);var pt=o.partialDone?' <span class="oc win" style="font-size:9px">½TP</span>':'';return '<tr><td class="muted">'+o.acct+'</td><td>'+o.symbol+'</td><td class="'+(o.direction==='LONG'?'pos':'neg')+'">'+o.direction+'</td><td class="name muted">'+o.source+pt+'</td><td class="muted">'+fmt(o.entry)+'</td><td class="muted">'+st+' / '+fmt(o.target)+'</td><td>'+tpsl(o)+'</td><td>'+fmt(o.price)+'</td><td class="'+oc+'">'+(o.uPnlUsd>=0?'+':'')+'$'+o.uPnlUsd.toFixed(2)+' ('+(o.uR>=0?'+':'')+o.uR.toFixed(2)+'R)</td><td><button class="btn xs closebtn" data-id="'+o.id+'" data-account="'+o.accid+'">Close</button></td></tr>';}).join('');$('tradepos').innerHTML='<table><tr><th>account</th><th>symbol</th><th>dir</th><th>signal</th><th>entry</th><th>stop / target</th><th>tp / sl</th><th>price</th><th>open P&L</th><th></th></tr>'+rows+'</table>';}catch(e){}}
async function addManual(ev){ev.preventDefault();var f=ev.target;var d={symbol:f.symbol.value,direction:f.direction.value,entry:f.entry.value,size:f.size.value,stop:f.stop.value,target:f.target.value,note:f.note.value};try{var r=await (await fetch('/api/manual',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)})).json();if(r&&r.ok===false){alert('Could not add trade: '+(r.error||'check inputs'));return false;}f.reset();loadManual();}catch(e){}return false;}
function closeManual(id){fetch('/api/manual/close',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})}).then(function(){loadManual();});}
function deleteManual(id){if(!confirm('Delete this trade from your log?'))return;fetch('/api/manual/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})}).then(function(){loadManual();});}
async function loadManual(){try{var m=await (await fetch('/api/manual')).json();if(!m)return;var sum='<div class="msum"><span>Trades <b>'+m.count+'</b></span><span>Open <b>'+m.openCount+'</b></span><span>Realized <b class="'+(m.realizedUsd>=0?'pos':'neg')+'">'+pmoney(m.realizedUsd)+'</b></span><span>Open P&L <b class="'+(m.unrealizedUsd>=0?'pos':'neg')+'">'+pmoney(m.unrealizedUsd)+'</b></span>'+(m.closedCount?'<span>Win rate <b>'+m.winRate.toFixed(0)+'%</b></span>':'')+'</div>';if(!m.trades.length){$('manual').innerHTML=sum+'<span class="empty">no trades logged — add one above</span>';return;}var rows=m.trades.map(function(t){var pnl=t.status==='open'?t.uPnlUsd:(t.pnlUsd||0);var pc=pnl>=0?'pos':'neg';var act=t.status==='open'?'<button class="btn xs mclose" data-id="'+t.id+'">Close</button> ':'';return '<tr><td class="muted">'+dtIST(t.openedAt)+'</td><td>'+t.symbol+'</td><td class="'+(t.direction==='LONG'?'pos':'neg')+'">'+t.direction+'</td><td class="muted">'+fmt(t.entry)+'</td><td class="muted">'+t.size+'</td><td class="muted">'+fmt(t.price)+'</td><td class="'+pc+'">'+(pnl>=0?'+':'')+'$'+pnl.toFixed(2)+'</td><td>'+(t.status==='open'?'<span class="oc open">OPEN</span>':'<span class="oc '+((t.pnlUsd||0)>=0?'win':'lost')+'">CLOSED</span>')+'</td><td>'+act+'<button class="btn xs mdel" data-id="'+t.id+'">✕</button></td></tr>';}).join('');$('manual').innerHTML=sum+'<table><tr><th>opened</th><th>symbol</th><th>dir</th><th>entry</th><th>size</th><th>price</th><th>P&L</th><th>status</th><th></th></tr>'+rows+'</table>';}catch(e){}}
document.addEventListener('click',function(e){if(!e.target||!e.target.closest)return;var mc=e.target.closest('.mclose');if(mc){closeManual(mc.getAttribute('data-id'));return;}var md=e.target.closest('.mdel');if(md){deleteManual(md.getAttribute('data-id'));return;}});
tick();loadJournal();loadBacktest();loadAlerts();loadSpoof();loadSweeps();loadPaper();loadReversals();loadConfig();loadPnl();loadTradePos();loadManual();
setInterval(tick,1000);setInterval(loadAlerts,2000);setInterval(loadJournal,5000);setInterval(loadBacktest,60000);setInterval(loadSpoof,5000);setInterval(loadSweeps,5000);setInterval(loadPaper,3000);setInterval(loadReversals,5000);setInterval(loadConfig,60000);setInterval(loadPnl,5000);setInterval(loadTradePos,3000);setInterval(loadManual,4000);
</script>
</body></html>`;

  // ══ State ════════════════════════════════════════════════════════════════════
  let svgEl,gEl,zoomBehavior,nodesEl,linksEl;
  let currentWidth=0,currentHeight=0,resizeTimer=null;
  let currentWikiSlug="",currentPanelMode="country";
  let _chartsBuilt = false;    // H1: analytics charts built-once guard
  let _wikiAbort   = null;     // H2: AbortController for in-flight Wikipedia fetch
  const _livePopCache = {};    // M3: REST API pop values cached for FALLBACK enrichment
  // ══ DATA ════════════════════════════════════════════════════════════════════
  // DB and REGION_DB are populated at runtime from africa-db-data-fixed.json
  let DB = {};
  let REGION_DB = {};

  // Population demographics [men%, women%, teens 13-17%, children 0-12%]
  const POP_DEMO = {
    default:[49,51,10,29],
    "Nigeria":[50,50,9,33],"Ethiopia":[50,50,10,35],"Egypt":[51,49,10,27],
    "South Africa":[49,51,10,24],"Kenya":[50,50,11,31],"Algeria":[51,49,10,26],
    "Morocco":[50,50,10,25],"Ghana":[49,51,10,30],"Tanzania":[50,50,11,33],
    "DR Congo":[50,50,12,36],"Sudan":[50,50,11,34],"Angola":[49,51,12,36],
    "Cameroon":[50,50,11,33],"Senegal":[49,51,11,32],"Tunisia":[51,49,9,23],
    "Libya":[54,46,10,27],"Western Sahara":[52,48,10,28],
  };


  // GDP scale for bar (relative to Nigeria's $477B as 100%)
  const GDP_MAX = 477;

  // FALLBACK tree is built dynamically from JSON at init (see init() below)
  let FALLBACK = { name:"Africa", stats:"54 Countries | 1.4B Population", children:[] };


  const REGION_COLORS=["#FBD165","#CD00CD","#0000FF","#E65100","#00AA00"];
  const ROOT_COLOR="#360800";
  let nodeColorScale;

  // Cached panel DOM references (looked up once, reused on every showDetails call)
  const _panelEl    = document.getElementById("details-panel");
  const _panelBadge = document.getElementById("panel-type-badge");
  const _panelFlag  = document.getElementById("panel-flag");
  const _panelDot   = document.getElementById("panel-region-dot");
  const _wikiBtnLbl = document.getElementById("wiki-btn-label");

  // ══ Init ═══════════════════════════════════════════════════════════════════
  async function init(){
    // Step 1 — load the local JSON database (DB, REGION_DB, FALLBACK)
    try{
      const dbRes = await fetch("africa-db-data-fixed.json");
      if(!dbRes.ok) throw new Error(`JSON DB fetch failed: ${dbRes.status}`);
      const jsonData = await dbRes.json();
      // Populate country and region lookup objects
      DB       = jsonData.countries || {};
      REGION_DB= jsonData.regions   || {};
      // Build the D3 tree FALLBACK from region members + country capitals
      FALLBACK = {
        name:"Africa", stats:"54 Countries | 1.4B Population",
        children: Object.entries(REGION_DB).map(([regName,regData])=>({
          name: regName,
          stats:`${regData.countries} Countries`,
          children:(regData.members||[]).map(member=>({
            name:member,
            cap: DB[member]?.cap ?? "N/A",
            // M3: pop now present in JSON; _livePopCache enriches if API ran first
            pop: DB[member]?.pop ?? _livePopCache[member] ?? "N/A"
          }))
        }))
      };
    }catch(dbErr){
      console.warn("Local JSON DB failed — detail panels will show N/A:", dbErr);
    }
    // Step 2 — try live REST Countries API for richer tree node data
    try{
      const res=await fetch("https://restcountries.com/v3.1/region/africa?fields=name,capital,subregion,population,flags,languages,currencies,area");
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const liveData = await res.json();
      // M3: Cache population from live API so FALLBACK is enriched if API
      //     goes offline mid-session or on next render
      liveData.forEach(c => {
        if(c.name?.common && c.population)
          _livePopCache[c.name.common] = c.population.toLocaleString();
      });
      render(buildHierarchy(liveData));
    }catch(err){
      console.warn("Live API failed — using offline JSON dataset:", err);
      showError("Live data unavailable — offline dataset loaded.");
      render(FALLBACK);
    }
  }
  function buildHierarchy(countries){
    const map=new Map();
    countries.forEach(c=>{
      const sub=c.subregion||"Other Africa";
      if(!map.has(sub)) map.set(sub,[]);
      map.get(sub).push({name:c.name.common,cap:c.capital?.[0]??"N/A",pop:c.population?.toLocaleString()??"N/A",popRaw:c.population,flag:c.flags?.svg??"",lang:c.languages?Object.values(c.languages).join(", "):"N/A",area:c.area?c.area.toLocaleString()+" km²":"N/A",currency:c.currencies?Object.values(c.currencies).map(x=>x.name).join(", "):"N/A"});
    });
    return{name:"Africa",stats:"54 Countries | 1.4B Population",children:Array.from(map.entries()).map(([sub,kids])=>({name:sub,stats:`${kids.length} Countries`,children:kids}))};
  }

  // ══ Render ══════════════════════════════════════════════════════════════════
  function render(data){
    navTo("map"); // always show map first
    // Use rAF to let browser commit layout after navTo's DOM changes
    // This prevents NaN from reading clientWidth during reflow
    requestAnimationFrame(() => _renderTree(data));
  }
  function _renderTree(data){
    const container=document.getElementById("radial-tree").parentElement;
    currentWidth=container.clientWidth; currentHeight=container.clientHeight;
    // Guard: if container has no size (hidden/unmounted), retry once
    if(!currentWidth || !currentHeight){
      requestAnimationFrame(() => _renderTree(data));
      return;
    }
    // Populate SVG map background (non-blocking)
    try { initMapSVG(); } catch(bgErr) { console.warn('Map SVG error:', bgErr); }
    const radius=Math.min(currentWidth,currentHeight)/2.55;
    svgEl=d3.select("#radial-tree").attr("width",currentWidth).attr("height",currentHeight);
    svgEl.selectAll("*").remove();
    gEl=svgEl.append("g");
    zoomBehavior=d3.zoom().scaleExtent([0.25,10]).on("zoom",e=>gEl.attr("transform",e.transform));
    svgEl.call(zoomBehavior);
    const root=d3.tree().size([2*Math.PI,radius])(d3.hierarchy(data).sort((a,b)=>d3.ascending(a.data.name,b.data.name)));
    const regionNames=root.children?.map(d=>d.data.name)??[];
    nodeColorScale=d3.scaleOrdinal(regionNames,REGION_COLORS);
    const nodeColor=d=>d.depth===0?ROOT_COLOR:d.depth===1?nodeColorScale(d.data.name):nodeColorScale(d.parent.data.name);
    linksEl=gEl.append("g").selectAll("path").data(root.links()).join("path").attr("class","link").attr("d",d3.linkRadial().angle(d=>d.x).radius(d=>d.y));
    nodesEl=gEl.append("g").selectAll("g").data(root.descendants()).join("g")
      .attr("class","node").attr("transform",d=>`rotate(${d.x*180/Math.PI-90}) translate(${d.y},0)`)
      .style("cursor",d=>d.depth>0?"pointer":"default")
      .attr("tabindex", d=>d.depth>0?"0":"-1")
      .attr("role", d=>d.depth>0?"button":"none")
      .attr("aria-label", d=>d.depth>0?`${d.data.name}, ${d.depth===1?"region":"country in "+d.parent.data.name}`:"")
      .on("click",(event,d)=>{event.stopPropagation();if(d.depth>0)showDetails(d);})
      .on("keydown",(event,d)=>{if((event.key==="Enter"||event.key===" ")&&d.depth>0){event.preventDefault();showDetails(d);}})
      .on("pointerenter",(event,d)=>showTooltip(event,d))
      .on("pointermove",event=>moveTooltip(event))
      .on("pointerleave",()=>hideTooltip());
    nodesEl.append("circle").attr("r",d=>d.depth===0?13:d.depth===1?9:5).attr("fill",d=>nodeColor(d)).attr("stroke","#fff").attr("stroke-width",d=>d.depth===0?3:1.5);
    nodesEl.append("text").attr("dy","0.31em").attr("x",d=>d.x<Math.PI===!d.children?12:-12).attr("text-anchor",d=>d.x<Math.PI===!d.children?"start":"end").attr("transform",d=>d.x>=Math.PI?"rotate(180)":null).style("font-weight",d=>d.depth<=1?"700":"500").style("fill","var(--md-on-surface)").style("pointer-events","none").text(d=>d.data.name);

    // ── Node entrance animation (staggered opacity fade by depth) ──
    const _nodeArr = nodesEl.nodes();
    const _sorted = _nodeArr.slice().sort((a,b) => {
      const da = d3.select(a).datum().depth;
      const db = d3.select(b).datum().depth;
      return da !== db ? da - db : _nodeArr.indexOf(a) - _nodeArr.indexOf(b);
    });
    nodesEl.attr("opacity", 0);
    linksEl.attr("opacity", 0);
    _sorted.forEach((_node, _i) => {
      const _d = d3.select(_node).datum();
      const _delay = _d.depth === 0 ? 0
                   : _d.depth === 1 ? 80 + (_i * 32)
                   : 360 + (_i * 8);
      d3.select(_node)
        .transition().delay(Math.min(_delay, 1500)).duration(400).ease(d3.easeCubicOut)
        .attr("opacity", 1);
    });
    linksEl.transition().delay(160).duration(650).ease(d3.easeCubicOut).attr("opacity", 1);
    svgEl.on("click",()=>{nodesEl.classed("dimmed",false);closePanel();});
    const handleSearch=debounce(function(){
      const term=this.value.trim().toLowerCase();
      document.getElementById("search-clear").classList.toggle("hidden",!term);
      if(!term){nodesEl.classed("dimmed",false);linksEl.classed("dimmed",false);return;}
      const match=d=>
        d.data.name?.toLowerCase().includes(term)||
        d.data.cap?.toLowerCase().includes(term);
      nodesEl.classed("dimmed",d=>!match(d));
      linksEl.classed("dimmed",true);
      const first=root.descendants().find(match);
      if(first) panTo(first,2);
    },120);
    d3.select("#node-search").on("input",handleSearch);
    document.getElementById("search-clear").addEventListener("click",()=>{
      document.getElementById("node-search").value="";
      document.getElementById("node-search").dispatchEvent(new Event("input"));
    });
    hideLoading(); resetZoom();
    // Flush any callbacks queued by goToCountry() before tree was ready
    _flushPostRenderCallbacks();
  }

  // ══ Tooltip ══════════════════════════════════════════════════════════════════
  const tooltipEl=document.getElementById("tooltip");
  function showTooltip(event,d){
    if(d.depth===0) return;
    const isRegion=d.depth===1;
    tooltipEl.innerHTML=isRegion
      ?`<strong>${d.data.name}</strong><br><span style="font-size:10px;opacity:.8">Click for regional data</span>`
      :`<strong>${d.data.name}</strong><br>Capital: ${d.data.cap??"N/A"}`+(d.data.pop?`<br>Pop: ${d.data.pop}`:"");
    tooltipEl.style.visibility="visible"; moveTooltip(event);
  }
  function moveTooltip(e){tooltipEl.style.left=`${Math.min(e.clientX+14,innerWidth-230)}px`;tooltipEl.style.top=`${Math.max(e.clientY-10,8)}px`;}
  function hideTooltip(){tooltipEl.style.visibility="hidden";}

  // ══ Unified showDetails — handles both region (depth=1) and country (depth=2) ═
  function showDetails(d){
    nodesEl.classed("dimmed",nd=>nd!==d&&nd.parent!==d&&nd!==d.parent);
    const isRegion=d.depth===1;
    currentPanelMode=isRegion?"region":"country";
    // Adjust panel header
    _panelBadge.textContent=isRegion?"Region":"Country";
    _panelBadge.className="panel-type-badge "+(isRegion?"panel-type-region":"panel-type-country");
    set("panel-title",d.data.name);
    set("panel-subtitle",isRegion?"Africa — Sub-regional Zone":(d.parent.data.name+" Region"));
    // Flag or region dot
    if(isRegion){
      _panelFlag.style.display="none"; _panelDot.style.display="block";
      const color=nodeColorScale?.(d.data.name)||"#6750A4";
      _panelDot.style.background=color; _panelDot.style.width="20px"; _panelDot.style.height="20px"; _panelDot.style.borderRadius="6px";
    }else{
      _panelDot.style.display="none";
      _panelFlag.style.display=d.data.flag?"block":"none";
      _panelFlag.src=d.data.flag||""; _panelFlag.alt=d.data.name+" flag";
    }
    // Show/hide sections
    const sectionMap = {overview:"ov", economy:"ec", people:"pe", climate:"cl"};
    ["overview","economy","people","climate"].forEach(tab=>{
      const pfx=sectionMap[tab];
      const cEl=document.getElementById(`${pfx}-country-section`);
      const rEl=document.getElementById(`${pfx}-region-section`);
      if(cEl) cEl.style.display=isRegion?"none":"block";
      if(rEl) rEl.style.display=isRegion?"block":"none";
    });
    // Update wiki button
    _wikiBtnLbl.textContent=isRegion?"Open Wikipedia (Region)":"Open Wikipedia Article";
    // Fill data
    if(isRegion) fillRegionData(d);
    else fillCountryData(d);
    // Reset to overview tab
    document.querySelectorAll(".tab-btn").forEach(b=>b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p=>p.classList.remove("active"));
    document.querySelector('[data-tab="overview"]').classList.add("active");
    document.getElementById("tab-overview").classList.add("active");
    _panelEl.classList.add("open"); _panelEl.setAttribute("aria-hidden","false");
    const offset=innerWidth>768?-currentWidth/5:0;
    panTo(d,1.4,offset);
  }

  function fillCountryData(d){
    const name=d.data.name;
    const db=DB[name]||{};
    currentWikiSlug=db.wiki||name.replace(/ /g,"_");
    // Overview
    set("ov-capital",d.data.cap||"—");
    set("ov-indep",db.indep||"—"); set("ov-colonial",db.colonial||"—");
    set("ov-gov",db.gov||"—"); set("ov-lang",db.lang||d.data.lang||"—");
    set("ov-area",db.area||d.data.area||"—"); set("ov-religion",db.religion||"—");
    set("ov-politics",db.politics||"Data not available for this country in the current dataset.");
    chips("ov-blocs",db.blocs||[],"chip");
    // Wiki
    fetchWiki(name,db.wiki);
    // Economy
    set("ec-gdp",db.gdp||d.data.currency||"N/A");
    const gdpNum=parseFloat((db.gdp||"0").replace(/[$B]/g,""))||0;
    setW("ec-gdp-bar",Math.min(100,Math.round(gdpNum/GDP_MAX*100)));
    set("ec-gdppc",db.gdppc||"N/A"); set("ec-growth",db.growth||"N/A");
    setNote("ec-growth",db.growth_note);
    set("ec-inflation",db.inflation||"N/A");
    setNote("ec-inflation",db.inflation_note); set("ec-unemploy",db.unemploy||"N/A");
    setNote("ec-unemploy",db.unemploy_note);
    set("ec-currency",db.currency||d.data.currency||"N/A");
    set("ec-gini",db.gini||"N/A");
    setNote("ec-gini",db.gini_note); set("ec-debt",db.debt||"N/A");
    set("ec-fdi",db.fdi||"N/A"); set("ec-remit",db.remit||"N/A");
    set("ec-internet",db.internet||"N/A"); set("ec-mobile",db.mobile||"N/A");
    set("ec-desc",db.econdesc||"Economic data not available for this country.");
    chips("ec-exports",db.exports||[],"chip");
    chips("ec-imports",db.imports||[],"chip-blue");
    chips("ec-partners",db.partners||[],"chip-green");
    chips("ec-blocs",db.blocs||[],"chip");
    // People
    const pop=d.data.pop||(d.data.popRaw?.toLocaleString())||"N/A";
    const popRaw=d.data.popRaw||0;
    set("pe-total",pop);
    const demo=POP_DEMO[name]||POP_DEMO.default;
    const[mP,wP,tP,cP]=demo;
    setW("pb-men",mP);setW("pb-women",wP);setW("pb-teens",tP);setW("pb-child",cP);
    const fmt=pct=>(popRaw?fmtN(Math.round(popRaw*pct/100))+"  ":"")+`(${pct}%)`;
    set("pe-men",fmt(mP));set("pe-women",fmt(wP));set("pe-teens",fmt(tP));set("pe-child",fmt(cP));
    set("pe-medage",db.medage?db.medage+" yrs":"N/A");
    set("pe-lifeexp",db.lifeexp||"N/A"); set("pe-lifeexp-m",db.lifeexpm||"N/A"); set("pe-lifeexp-f",db.lifeexpf||"N/A");
    set("pe-fertility",db.fertility?db.fertility+" births/woman":"N/A");
    set("pe-urban",db.urban||"N/A"); set("pe-rural",db.rural||"N/A");
    set("pe-growth",db.popgrowth||"N/A"); set("pe-literacy",db.literacy||"N/A");
    set("pe-lit-m",db.litm||"N/A"); set("pe-lit-f",db.litf||"N/A");
    set("pe-hdi",db.hdi||"N/A"); set("pe-u5mort",db.u5mort||"N/A");
    set("pe-infant",db.infant||"N/A"); set("pe-physicians",db.physicians||"N/A");
    set("pe-school",db.school||"N/A");
    chips("pe-ethnicity",db.ethnicity||[],"chip");
    // Climate
    const czEl=document.getElementById("cl-zones"); czEl.innerHTML="";
    (db.climate||["Tropical"]).forEach(z=>{const s=document.createElement("span");s.className="climate-badge";s.innerHTML=`<span class="material-symbols-outlined" style="font-size:13px">wb_sunny</span>${z}`;czEl.appendChild(s);});
    set("cl-temp",db.temp||"N/A"); set("cl-rain",db.rain||"N/A");
    set("cl-hot",db.hot||"N/A"); set("cl-cool",db.cool||"N/A");
    set("cl-rainy",db.rainy||"N/A"); set("cl-dry",db.dry||"N/A");
    set("cl-humidity",db.humidity||"N/A"); set("cl-sunshine",db.sunshine||"N/A");
    set("cl-desc",db.climdesc||"Climate data not available."); set("cl-impact",db.impact||"Climate impact data not available.");
    chips("cl-risks",db.risks||[],"chip-red");
    chips("cl-features",db.features||[],"chip-green");
  }

  function fillRegionData(d){
    const name=d.data.name;
    const r=REGION_DB[name]||{};
    currentWikiSlug=r.wiki||name.replace(/ /g,"_");
    // Overview
    set("reg-countries",r.countries||d.children?.length||"—");
    set("reg-pop",r.pop||"—"); set("reg-gdp",r.gdp||r.ec_gdp||"—");
    set("reg-gdppc",r.gdppc||r.ec_gdppc||"—"); set("reg-largest",r.largest||r.ec_largest||"—");
    set("reg-bloc",r.bloc||"—"); set("reg-chars",r.chars||"Regional overview data not available.");
    chips("reg-langs",r.langs||[],"chip"); set("reg-religion",r.religion||"—");
    chips("reg-members",r.members||d.children?.map(c=>c.data.name)||[],"chip-green");
    // Wiki (use region article)
    fetchWiki(name,r.wiki);
    // Economy
    set("reg-ec-gdp",r.ec_gdp||"—"); set("reg-ec-gdppc",r.ec_gdppc||"—");
    set("reg-ec-growth",r.ec_growth||"—"); set("reg-ec-inflation",r.ec_inflation||"—");
    set("reg-ec-largest",r.ec_largest||"—"); set("reg-ec-export",r.ec_export||"—");
    set("reg-ec-desc",r.ec_desc||"Regional economic data not available.");
    chips("reg-ec-industries",r.ec_industries||[],"chip");
    chips("reg-ec-blocs",r.ec_blocs||[],"chip-blue");
    // People
    set("reg-pe-total",r.pe_total||"—"); set("reg-pe-medage",r.pe_medage||"—");
    set("reg-pe-lifeexp",r.pe_lifeexp||"—"); set("reg-pe-fertility",r.pe_fertility||"—");
    set("reg-pe-urban",r.pe_urban||"—"); set("reg-pe-literacy",r.pe_literacy||"—");
    set("reg-pe-hdi",r.pe_hdi||"—"); set("reg-pe-note",r.pe_note||"—");
    // Climate
    const rczEl=document.getElementById("reg-cl-zones"); rczEl.innerHTML="";
    (r.cl_zones||["Tropical"]).forEach(z=>{const s=document.createElement("span");s.className="climate-badge";s.innerHTML=`<span class="material-symbols-outlined" style="font-size:13px">wb_sunny</span>${z}`;rczEl.appendChild(s);});
    set("reg-cl-temp",r.cl_temp||"—"); set("reg-cl-rain",r.cl_rain||"—");
    set("reg-cl-desc",r.cl_desc||"—");
    chips("reg-cl-risks",r.cl_risks||[],"chip-red");
  }

  // H2 FIX: Wikipedia response cache — avoids re-fetching the same article
  const _wikiCache = new Map();

  async function fetchWiki(name,slug){
    const el=document.getElementById("wiki-summary");
    const key=(slug||name).replace(/ /g,"_");

    // Serve from cache immediately — no skeleton flash on repeat opens
    if(_wikiCache.has(key)){
      el.textContent=_wikiCache.get(key); el.className=""; el.style.minHeight="";
      return;
    }

    // Abort any in-flight request for a previous country/region
    if(_wikiAbort){ _wikiAbort.abort(); }
    _wikiAbort = new AbortController();
    const signal = _wikiAbort.signal;

    el.textContent=""; el.className="skel"; el.style.minHeight="56px";
    try{
      const res=await fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(key)}`,
        { signal }
      );
      if(!res.ok) throw new Error("404");
      const json=await res.json();
      const text=json.extract?json.extract.split(". ").slice(0,4).join(". ")+".":"No Wikipedia summary available.";
      _wikiCache.set(key, text);                  // store for future opens
      el.textContent=text; el.className=""; el.style.minHeight="";
    }catch(err){
      // Ignore AbortError — a newer request superseded this one
      if(err.name==="AbortError") return;
      const fallback=`${name} is located in Africa. Wikipedia summary could not be loaded in this environment.`;
      _wikiCache.set(key, fallback);
      el.textContent=fallback; el.className=""; el.style.minHeight="";
    }
  }
  function openWiki(){window.open(`https://en.wikipedia.org/wiki/${encodeURIComponent(currentWikiSlug)}`,"_blank","noopener,noreferrer");}
  function closePanel(){
    _panelEl.classList.remove("open");
    _panelEl.setAttribute("aria-hidden","true");
    nodesEl?.classed("dimmed",false); resetZoom();
    // Return focus to map
    document.getElementById("page-map")?.focus?.();
  }

  // Focus trap for details panel
  document.addEventListener("keydown", e => {
    if(!_panelEl?.classList.contains("open")) return;
    if(e.key === "Escape") { closePanel(); return; }
    if(e.key !== "Tab") return;
    const focusable = Array.from(_panelEl.querySelectorAll(
      'button:not([disabled]),a,[tabindex="0"],input,select,textarea'
    )).filter(el=>!el.closest('[style*="display:none"]') && el.offsetParent !== null);
    if(!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length-1];
    if(e.shiftKey ? document.activeElement===first : document.activeElement===last){
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  });
  // ══ goToCountry — from region page chips ══════════════════════════════════
  // Navigate to map, then select the country node by name.
  // Uses a callback queue rather than a fixed setTimeout so it fires as soon
  // as the D3 tree is ready — reliable on both fast and slow devices.
  const _postRenderCallbacks = [];
  function _flushPostRenderCallbacks() {
    while (_postRenderCallbacks.length) {
      const cb = _postRenderCallbacks.shift();
      try { cb(); } catch(e) { console.warn('Post-render callback error:', e); }
    }
  }

  function goToCountry(name) {
    navTo('map');
    // If tree is already rendered, execute immediately; otherwise queue for
    // the next time _renderTree() completes (see flush call at end of render).
    const selectNode = () => {
      if (!nodesEl) return;
      let target = null;
      nodesEl.each(function(d) {
        if (d.depth === 2 && d.data.name === name) target = d;
      });
      if (target) {
        showDetails(target);
        panTo(target, 1.4, innerWidth > 768 ? -currentWidth / 5 : 0);
      }
    };
    if (nodesEl) {
      selectNode();
    } else {
      _postRenderCallbacks.push(selectNode);
    }
  }


  // ══ ANALYTICS CHARTS ══════════════════════════════════════════════════════
  function initAnalyticsCharts() {
    // H1 FIX: build charts only once — theme colours are read at call time
    // so the first render is always colour-correct; no re-render needed.
    if (_chartsBuilt) return;
    _chartsBuilt = true;

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const textColor = isDark ? '#CAC4D0' : '#49454F';
    const barBg = isDark ? '#2D2D3A' : '#F3EDF7';

    // GDP data: extract from DB, sort descending
    const gdpData = Object.entries(DB)
      .filter(([k, v]) => v.gdp && !['Northern Africa','Western Africa','Eastern Africa','Central Africa','Southern Africa'].includes(k))
      .map(([k, v]) => {
        const raw = v.gdp.replace(/[$B]/g, '').replace(/[^0-9.]/g, '');
        return { name: k, val: parseFloat(raw) || 0 };
      })
      .filter(d => d.val > 0)
      .sort((a, b) => b.val - a.val)
      .slice(0, 10);

    // HDI data
    const hdiData = Object.entries(DB)
      .filter(([k, v]) => v.hdi && !['Northern Africa','Western Africa','Eastern Africa','Central Africa','Southern Africa'].includes(k))
      .map(([k, v]) => ({ name: k, val: parseFloat(v.hdi) || 0 }))
      .filter(d => d.val > 0)
      .sort((a, b) => b.val - a.val)
      .slice(0, 12);

    // Population data (from FALLBACK tree — always populated from JSON at init)
    const popMap = {};
    FALLBACK.children.forEach(reg => reg.children.forEach(c => {
      if (c.pop) popMap[c.name] = parseInt(c.pop.replace(/,/g,'')) / 1e6;
    }));
    const popData = Object.entries(popMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, val]) => ({ name, val: Math.round(val) }));

    // Region comparison data — derived from REGION_DB (loaded from JSON)
    const REGION_CHART_COLORS = {'Northern Africa':'#0000FF','Western Africa':'#00AA00','Eastern Africa':'#FBD165','Central Africa':'#CD00CD','Southern Africa':'#E65100'};
    const regionData = Object.entries(REGION_DB).map(([fullName,r])=>({
      name: fullName.replace(' Africa',''),
      color: REGION_CHART_COLORS[fullName]||'#888',
      gdp:  parseFloat((r.ec_gdp ||r.gdp ||'0').replace(/[$B,]/g,''))||0,
      pop:  parseFloat((r.pe_total||r.pop ||'0').replace(/[M,]/g,'')) ||0,
      hdi:  parseFloat((r.pe_hdi ||'0').replace(/[^0-9.]/g,''))       ||0,
    }));

    function renderBarChart(containerId, data, color, unit, maxVal) {
      const el = document.getElementById(containerId);
      if (!el) return;
      const max = maxVal || Math.max(...data.map(d => d.val)) * 1.1;
      el.innerHTML = data.map(d => {
        const pct = Math.round((d.val / max) * 100);
        const shortName = d.name.length > 18 ? d.name.slice(0, 16) + '…' : d.name;
        return `<div class="analytics-bar-row" style="display:flex;align-items:center;gap:10px;margin-bottom:10px;cursor:pointer;opacity:0;transform:translateX(-18px);transition:opacity 0.45s ease,transform 0.45s ease;"
                     onclick="goToCountry('${d.name.replace(/'/g,"\'")}')">
          <div style="width:130px;flex-shrink:0;font-size:.78rem;font-weight:600;color:${textColor};text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${shortName}</div>
          <div style="flex:1;background:${barBg};border-radius:6px;height:28px;position:relative;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:${color};border-radius:6px;transition:width .6s var(--md-easing-emphasized);display:flex;align-items:center;padding:0 8px;min-width:30px;">
              <span style="font-size:.75rem;font-weight:700;color:#fff;white-space:nowrap;">${unit === '$' ? '$' + d.val + 'B' : d.val + (unit || '')}</span>
            </div>
          </div>
        </div>`;
      }).join('');
      // Animate rows and bars in
      requestAnimationFrame(() => {
        // Animate bar fill widths
        el.querySelectorAll('div > div > div[style*="width:"]').forEach((bar, i) => {
          bar.style.transitionDelay = (i * 55) + 'ms';
        });
        // Animate row entrance
        el.querySelectorAll('.analytics-bar-row').forEach((row, i) => {
          setTimeout(() => {
            row.style.opacity = '1';
            row.style.transform = 'translateX(0)';
          }, i * 55);
        });
      });
    }

    renderBarChart('chart-gdp', gdpData, '#6750A4', '$');
    renderBarChart('chart-hdi', hdiData.map(d => ({...d, val: d.val})), '#2E7D32', '', 1.0);
    renderBarChart('chart-pop', popData, '#C2185B', 'M');

    // Region comparison table
    const regEl = document.getElementById('chart-regions');
    if (regEl) {
      regEl.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:.85rem;">
        <thead>
          <tr style="border-bottom:2px solid var(--md-surface-variant);">
            <th style="text-align:left;padding:8px 12px;color:${textColor};font-weight:700;">Region</th>
            <th style="text-align:right;padding:8px 12px;color:${textColor};font-weight:700;">GDP (B)</th>
            <th style="text-align:right;padding:8px 12px;color:${textColor};font-weight:700;">Pop (M)</th>
            <th style="text-align:right;padding:8px 12px;color:${textColor};font-weight:700;">Avg HDI</th>
            <th style="padding:8px 12px;color:${textColor};font-weight:700;">HDI Bar</th>
          </tr>
        </thead>
        <tbody>
          ${regionData.map(r => `<tr style="border-bottom:1px solid var(--md-surface-variant);cursor:pointer;" onclick="navTo('reg-${r.name.toLowerCase()}')">
            <td style="padding:10px 12px;font-weight:700;color:var(--md-on-surface);">
              <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${r.color};margin-right:8px;"></span>${r.name}
            </td>
            <td style="text-align:right;padding:10px 12px;color:var(--md-on-surface);">$${r.gdp}B</td>
            <td style="text-align:right;padding:10px 12px;color:var(--md-on-surface);">${r.pop}M</td>
            <td style="text-align:right;padding:10px 12px;color:var(--md-on-surface);">${r.hdi}</td>
            <td style="padding:10px 12px;">
              <div style="background:${barBg};border-radius:4px;height:16px;width:120px;">
                <div style="height:100%;width:${Math.round(r.hdi*100)}%;background:${r.color};border-radius:4px;"></div>
              </div>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    }
  }

  // Call when analytics page is shown (hooked into navTo)


  // ══ Zoom ══════════════════════════════════════════════════════════════════
  function panTo(d,scale=1.5,xOffset=0){
    const a=d.x-Math.PI/2;
    const x=currentWidth/2+xOffset-d.y*Math.cos(a)*scale;
    const y=currentHeight/2-d.y*Math.sin(a)*scale;
    svgEl.transition().duration(650).call(zoomBehavior.transform,d3.zoomIdentity.translate(x,y).scale(scale));
  }
  function resetZoom(){
    if(!svgEl||!zoomBehavior) return;
    svgEl.transition().duration(750).call(zoomBehavior.transform,d3.zoomIdentity.translate(currentWidth/2,currentHeight/2).scale(1));
  }

  // ══ Helpers ════════════════════════════════════════════════════════════════
  function set(id,v){const el=document.getElementById(id);if(el)el.textContent=v;}
  // L4: inject qualifier footnote into .stat-note element if it exists
  function setNote(id,v){const el=document.getElementById(id+"-note");if(el)el.textContent=v||"";}
  function setW(id,p){const el=document.getElementById(id);if(el)el.style.width=p+"%";}
  function fmtN(n){return n>=1e9?(n/1e9).toFixed(2)+"B":n>=1e6?(n/1e6).toFixed(1)+"M":n.toLocaleString();}
  // ── Performance helper: debounce ─────────────────────────────────────
  function debounce(fn,delay=120){
    let t;
    return function(...args){
      clearTimeout(t);
      t=setTimeout(()=>fn.apply(this,args),delay);
    };
  }

  function chips(id,arr,cls){
    const el=document.getElementById(id);if(!el)return;el.innerHTML="";
    if(!arr||!arr.length){el.textContent="—";return;}
    arr.forEach(v=>{const s=document.createElement("span");s.className=cls;s.textContent=v;el.appendChild(s);});
  }
  function hideLoading(){const el=document.getElementById("loading");el.style.transition="opacity .4s";el.style.opacity="0";setTimeout(()=>el.style.display="none",400);}
  function showError(msg){document.getElementById("error-msg").textContent=msg;document.getElementById("error-banner").classList.remove("hidden");}

  // ══ Tabs ════════════════════════════════════════════════════════════════════
  document.querySelectorAll(".tab-btn").forEach(btn=>{
    btn.addEventListener("click",()=>{
      document.querySelectorAll(".tab-btn").forEach(b=>b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p=>p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });

  // ══ PAGE NAVIGATION ════════════════════════════════════════════════════════
  // Map of nav keys → page element IDs
  const PAGE_MAP={
    home:'page-home',
    map:'page-map',
    'reg-north':'page-reg-north',
    'reg-west':'page-reg-west',
    'reg-east':'page-reg-east',
    'reg-central':'page-reg-central',
    'reg-south':'page-reg-south',
    analytics:'page-analytics',
    settings:'page-settings'
  };

  function navTo(key){
    // Hide all pages
    document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
    // Show target page
    const targetId=PAGE_MAP[key]||'page-map';
    const target=document.getElementById(targetId);
    if(target){
      target.classList.add('active');
      // Scroll to top of scrollable pages
      if(target.scrollTop!==undefined) target.scrollTop=0;
      // Trigger reveal animations for the newly shown page
      setTimeout(()=>observeReveals(target),50);
    }
    // Update nav button states
    document.querySelectorAll('[data-nav]').forEach(b=>{
      const match=b.dataset.nav===key||(key==='analytics'&&b.dataset.nav==='analytics');
      b.classList.toggle('active',match);
      b.setAttribute('aria-current',match?'page':'false');
    });
    // When going to map, trigger a resize to ensure D3 fills correctly
    if(targetId==='page-map') setTimeout(()=>onResize(),100);


    // When going to region pages, render geo hero maps
    if(['page-reg-north','page-reg-west','page-reg-east','page-reg-central','page-reg-south'].includes(targetId)){
      requestAnimationFrame(function(){ try { renderRegionHeroMaps(); } catch(e){ console.warn('Hero map error:',e); } });
    }
    // Re-render map background on theme change (called from theme toggle)
    if(targetId==='page-map') requestAnimationFrame(()=>initMapSVG());
    if(targetId==='page-home') requestAnimationFrame(()=>initHomeMapSVG());

    // When going to analytics, render charts
    if(key==='analytics') setTimeout(()=>{
      initAnalyticsCharts();
      // Stagger analytics section entrances
      const sections = document.querySelectorAll('#page-analytics .analytics-section');
      sections.forEach((s, i) => {
        s.style.opacity = '0';
        s.style.transform = 'translateY(28px)';
        s.style.transition = '';
        requestAnimationFrame(() => {
          setTimeout(() => {
            s.style.transition = 'opacity 0.6s cubic-bezier(.22,1,.36,1), transform 0.6s cubic-bezier(.22,1,.36,1)';
            s.style.opacity = '1';
            s.style.transform = 'translateY(0)';
          }, 60 + i * 110);
        });
      });
    }, 100);
  }

  // Re-render geo maps on window resize (debounced)
  // SVG maps are CSS-driven and scale automatically with width:100%/height:auto.
  // No resize re-render needed.
  var _geoResizeTimer; // retained to avoid ReferenceErrors elsewhere

  // Wire up nav buttons
  document.querySelectorAll('[data-nav]').forEach(btn=>{
    btn.addEventListener('click',()=>navTo(btn.dataset.nav));
  });

  // Wire up show-map button in app bar
  document.getElementById('btn-show-map')?.addEventListener('click',()=>navTo('map'));

  // ══ THEME TOGGLE ═══════════════════════════════════════════════════════════
  (function initTheme(){
    const root=document.documentElement;
    const icon=document.getElementById('theme-icon');
    // Respect system preference on first load
    const stored=localStorage.getItem('africa-theme');
    const prefersDark=window.matchMedia('(prefers-color-scheme:dark)').matches;
    const isDark=stored?stored==='dark':prefersDark;
    root.setAttribute('data-theme',isDark?'dark':'light');
    if(icon) icon.textContent=isDark?'light_mode':'dark_mode';

    document.getElementById('btn-theme')?.addEventListener('click',()=>{
      const nowDark=root.getAttribute('data-theme')==='dark';
      const next=nowDark?'light':'dark';
      root.setAttribute('data-theme',next);
      if(icon) icon.textContent=next==='dark'?'light_mode':'dark_mode';
      // Reset charts so they re-render with the new theme's colours
      _chartsBuilt = false;
      // SVG fills are CSS-driven; re-clone hero SVGs so dark-mode CSS applies
      // (cloneAfrica only needed to re-set theme class; clears & re-populates)
      // Hero SVGs need clearing so renderRegionHeroMaps() re-clones them
      document.querySelectorAll('.africa-hero-wrap','home-bg-wrap').forEach(w=>w.innerHTML='');
      initMapSVG();
      initHomeMapSVG();
      renderRegionHeroMaps();
      try{localStorage.setItem('africa-theme',next);}catch(e){}
      // Update theme-color meta for PWA
      const tcMeta=document.getElementById('theme-color-meta');
      if(tcMeta)tcMeta.content=next==='dark'?'#1C1B1F':'#F7F2F9';
    });
    // Set initial theme-color
    const tcMetaInit=document.getElementById('theme-color-meta');
    if(tcMetaInit)tcMetaInit.content=document.documentElement.getAttribute('data-theme')==='dark'?'#1C1B1F':'#F7F2F9';
  })();

  // ══ RIPPLE EFFECT ══════════════════════════════════════════════════════════
  //* MD3 Ripple — pointer-origin, CSS-var colour, auto-cleanup.
  //* Works on any element with [data-ripple] + .ripple-surface.
  function addRipple(e){
    const host=e.currentTarget;
    const rect=host.getBoundingClientRect();
    const size=Math.max(rect.width,rect.height)*2;
    const x=(e.clientX??rect.left+rect.width/2)-rect.left-size/2;
    const y=(e.clientY??rect.top+rect.height/2)-rect.top-size/2;
    const wave=document.createElement('span');
    wave.className='ripple-wave';
    // Use currentColor-aware background
    const isLight=document.documentElement.getAttribute('data-theme')!=='dark';
    wave.style.cssText=`width:${size}px;height:${size}px;left:${x}px;top:${y}px;background:${isLight?'rgba(0,0,0,.15)':'rgba(255,255,255,.2)'};`;
    host.appendChild(wave);
    wave.addEventListener('animationend',()=>wave.remove(),{once:true});
  }
  // Attach to all existing ripple-host elements
  document.querySelectorAll('.ripple-host').forEach(el=>{
    el.addEventListener('click',addRipple);
  });
  // MutationObserver for dynamically added ripple-hosts (panel cards etc.)
  const rippleObserver=new MutationObserver(mutations=>{
    mutations.forEach(m=>m.addedNodes.forEach(n=>{
      if(n.nodeType===1){
        if(n.classList?.contains('ripple-host')) n.addEventListener('click',addRipple);
        n.querySelectorAll?.('.ripple-host').forEach(el=>el.addEventListener('click',addRipple));
      }
    }));
  });
  rippleObserver.observe(document.body,{childList:true,subtree:true});

  // ══ SCROLL / ENTRANCE ANIMATIONS (IntersectionObserver) ════════════════════
  const revealIO=new IntersectionObserver((entries)=>{
    entries.forEach(entry=>{
      if(entry.isIntersecting){
        entry.target.classList.add('visible');
        revealIO.unobserve(entry.target);
      }
    });
  },{threshold:0.12,rootMargin:'0px 0px -40px 0px'});

  function observeReveals(root=document){
    root.querySelectorAll('.reveal,.reveal-left,.reveal-right').forEach(el=>{
      // Reset then observe (for re-navigation)
      el.classList.remove('visible');
      revealIO.observe(el);
    });
  }
  // Initial observe on DOMContentLoaded (map page is active by default,
  // but we show home on first load — see below)
  observeReveals();

  // ══ Resize ══════════════════════════════════════════════════════════════════
  function onResize(){
    if(!svgEl) return;  // D3 tree not yet initialised
    clearTimeout(resizeTimer);
    resizeTimer=setTimeout(()=>{
      const c=document.getElementById("page-map");
      if(!c||!svgEl)return;
      const nw=c.clientWidth,nh=c.clientHeight;
      if(Math.abs(nw-currentWidth)<20&&Math.abs(nh-currentHeight)<20)return;
      currentWidth=nw;currentHeight=nh;
      svgEl.attr("width",nw).attr("height",nh);
      resetZoom();
    },200);
  }

  document.addEventListener("DOMContentLoaded",function(){
    init();
    initMapSVG();  // Ensure bg map loads on first page open
    // L3: ResizeObserver fires on #page-map element resize (not just viewport),
    //     covering panel open/close and sidebar collapse — more accurate than
    //     window resize event.
    if(typeof ResizeObserver !== "undefined"){
      new ResizeObserver(onResize).observe(document.getElementById("page-map"));
    } else {
      window.addEventListener("resize", onResize);  // fallback for old browsers
    }
  });


  // ══ Africa SVG Map System ════════════════════════════════════════════════════
  //
  // Approach: one processed SVG stored in <template id="africa-svg-tpl">.
  // cloneAfrica() deep-clones it into any container and applies a highlight class.
  //
  // Highlighting mechanism:
  //   • All .africa-region path elements start dim (CSS default)
  //   • Adding class "hl-reg-{key}" on the SVG root makes that region vivid
  //   • CSS handles fill colours, glow (filter:drop-shadow), transitions
  //   • Dark mode: CSS [data-theme="dark"] overrides — zero JS needed
  //
  // No D3, no canvas, no GeoJSON, no OffscreenCanvas, no external dependencies.
  // Works in every browser that supports inline SVG (IE9+, all modern browsers).
  //
  // Public API:
  //   initMapSVG()           — populate map background (called once at tree render)
  //   renderRegionHeroMaps() — populate all 5 hero panels (called by navTo)
  // ═════════════════════════════════════════════════════════════════════════════

  // Region key → SVG group id (matches id= attrs set on the SVG template)
  var AFRICA_SVG_REGIONS = {
    'reg-north':   'Northern Africa',
    'reg-west':    'Western Africa',
    'reg-east':    'Eastern Africa',
    'reg-central': 'Central Africa',
    'reg-south':   'Southern Africa'
  };

  /**
   * cloneAfrica(container, hlKey)
   * Deep-clones the SVG template into `container`, replacing any existing SVG.
   * hlKey: optional region id string e.g. "reg-north" — adds class "hl-reg-north"
   *        on the SVG root so CSS activates that region's vivid style.
   * Returns the cloned SVG element, or null if the template is missing.
   */
  function cloneAfrica(container, hlKey) {
    if (!container) return null;
    var tpl = document.getElementById('africa-svg-tpl');
    if (!tpl) { console.warn('africa-svg-tpl template not found'); return null; }

    // Clear previous content
    container.innerHTML = '';

    // Deep-clone the template content
    var frag = tpl.content.cloneNode(true);
    var svgEl = frag.querySelector('svg');
    if (!svgEl) return null;

    // Apply highlight class if a region key is specified
    if (hlKey) {
      svgEl.classList.add('hl-' + hlKey);
    }

    container.appendChild(frag);
    return container.querySelector('svg');
  }

  /**
   * initMapSVG()
   * Populates the map page background with the full Africa SVG (no highlight).
   * Called once when the D3 tree first renders.
   */
  function initMapSVG() {
    var wrap = document.getElementById('map-bg-wrap');
    if (!wrap || wrap.querySelector('svg')) return; // already populated
    var svg = cloneAfrica(wrap, null);
    if (!svg) return;
    // Fade in after paint (rAF ensures the element is in the DOM first)
    requestAnimationFrame(function() {
      wrap.style.opacity = '1';
    });
  }
  function initHomeMapSVG() {
    var wrap = document.getElementById('home-bg-wrap');
    if (!wrap || wrap.querySelector('svg')) return; // already populated
    var svg = cloneAfrica(wrap, null);
    if (!svg) return;
    // Fade in after paint (rAF ensures the element is in the DOM first)
    requestAnimationFrame(function() {
      wrap.style.opacity = '1';
    });
  }
  /**
   * renderRegionHeroMaps()
   * Populates all 5 hero panels with region-highlighted SVG clones.
   * Called by navTo() when navigating to any region page.
   * Safe to call multiple times — checks if already rendered.
   */
  function renderRegionHeroMaps() {
    Object.keys(AFRICA_SVG_REGIONS).forEach(function(regionKey) {
      var wrap = document.querySelector(
        '[data-region="' + regionKey + '"].africa-hero-wrap'
      );
      if (!wrap) return;
      // Skip if already rendered (avoid redundant clones)
      if (wrap.querySelector('svg')) return;
      cloneAfrica(wrap, regionKey);
    });
  }


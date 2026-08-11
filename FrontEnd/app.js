const API = ""; // same-origin; backend serves this frontend too

let sessionId = null;
let scannedFiles = [];   // [{id,name,ext,key,size}]
let groups = [];         // [{key, files:[...]}]
let commonName = "";
let pendingFiles = [];   // File objects queued for upload
let appConfig = { allow_folder_scan:false, access_code_required:false };

function authHeaders(){
  const code = document.getElementById("accessCode").value.trim();
  return code ? { "X-Access-Code": code } : {};
}

async function loadConfig(){
  try{
    const res = await fetch(API + "/api/config");
    appConfig = await res.json();
  } catch(e){
    appConfig = { allow_folder_scan:false, access_code_required:false };
  }
  document.getElementById("folderPathField").style.display = appConfig.allow_folder_scan ? "block" : "none";
  document.getElementById("step2Hint").textContent = appConfig.allow_folder_scan
    ? "Either type a folder path that exists on the machine running this server, or upload files/a folder from this device. You can use both."
    : "Upload files, or drag a folder from this device into the drop zone.";
  document.getElementById("accessStep").style.display = appConfig.access_code_required ? "block" : "none";
}
loadConfig();

function sanitizeName(s){
  return (s||"").toString().trim().replace(/[\\/:*?"<>|]+/g,"-").replace(/\s+/g,"-").replace(/-+/g,"-") || "UNNAMED";
}
function sanitizeKey(k){ return (k||"").toString().replace(/[^A-Za-z0-9\-]/g,"").toUpperCase(); }
function fmtBytes(n){
  if(n<1024) return n+" B";
  if(n<1024*1024) return (n/1024).toFixed(1)+" KB";
  return (n/1024/1024).toFixed(1)+" MB";
}
function log(el, msg, isErr){
  el.style.display = "block";
  const d = document.createElement("div");
  if(isErr) d.className = "err";
  d.textContent = msg;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
}

const step2 = document.getElementById("step2");
const step3 = document.getElementById("step3");
const step4 = document.getElementById("step4");
const commonNameInput = document.getElementById("commonName");

commonNameInput.addEventListener("input", ()=>{
  commonName = commonNameInput.value.trim();
  step2.classList.toggle("disabled", commonName.length === 0);
  document.getElementById("nameHint").textContent =
    (sanitizeName(commonName)||"NAME") + "_" + "HAWBCODE" + ".pdf";
});

// ---- file intake (client-side upload queue) ----
const dropzone = document.getElementById("dropzone");
const filesInput = document.getElementById("filesInput");
const folderInput = document.getElementById("folderInput");
document.getElementById("pickFilesBtn").addEventListener("click", ()=>filesInput.click());
document.getElementById("pickFolderBtn").addEventListener("click", ()=>folderInput.click());
filesInput.addEventListener("change", e=> addIncomingFiles(Array.from(e.target.files)));
folderInput.addEventListener("change", e=> addIncomingFiles(Array.from(e.target.files)));

["dragenter","dragover"].forEach(evt=>{
  dropzone.addEventListener(evt, e=>{ e.preventDefault(); dropzone.classList.add("drag"); });
});
["dragleave","drop"].forEach(evt=>{
  dropzone.addEventListener(evt, e=>{ e.preventDefault(); dropzone.classList.remove("drag"); });
});
dropzone.addEventListener("drop", async e=>{
  e.preventDefault();
  const items = e.dataTransfer.items;
  if(items && items.length && items[0].webkitGetAsEntry){
    const entries = Array.from(items).map(it=>it.webkitGetAsEntry()).filter(Boolean);
    const files = [];
    await Promise.all(entries.map(en=>walkEntry(en, files)));
    addIncomingFiles(files);
  } else {
    addIncomingFiles(Array.from(e.dataTransfer.files));
  }
});
function walkEntry(entry, out){
  return new Promise(resolve=>{
    if(entry.isFile){
      entry.file(f=>{ out.push(f); resolve(); }, ()=>resolve());
    } else if(entry.isDirectory){
      const reader = entry.createReader();
      reader.readEntries(async entries=>{
        await Promise.all(entries.map(en=>walkEntry(en, out)));
        resolve();
      }, ()=>resolve());
    } else resolve();
  });
}

const SUPPORTED = ["pdf","docx","doc","xlsx","xls","csv","txt","png","jpg","jpeg","webp","bmp","gif","tif","tiff"];
function getExt(name){ const m = name.toLowerCase().match(/\.([a-z0-9]+)$/); return m?m[1]:""; }

function addIncomingFiles(fileArr){
  const added = fileArr.filter(f=>SUPPORTED.includes(getExt(f.name)));
  pendingFiles = pendingFiles.concat(added);
  document.getElementById("fileCount").textContent = pendingFiles.length + " file(s) queued for upload";
  const preview = document.getElementById("fileListPreview");
  preview.innerHTML = "";
  pendingFiles.slice(0,60).forEach(f=>{
    const d = document.createElement("div");
    d.textContent = f.name + "  ·  " + fmtBytes(f.size);
    preview.appendChild(d);
  });
  if(pendingFiles.length > 60){
    const d = document.createElement("div");
    d.textContent = "… and " + (pendingFiles.length-60) + " more";
    preview.appendChild(d);
  }
}

// ---- scan ----
document.getElementById("scanBtn").addEventListener("click", async ()=>{
  const folderPath = document.getElementById("folderPath").value.trim();
  if(!folderPath && pendingFiles.length === 0){
    alert("Type a server folder path or add files first.");
    return;
  }
  const btn = document.getElementById("scanBtn");
  btn.disabled = true;
  const wrap = document.getElementById("scanProgressWrap");
  const scanLog = document.getElementById("scanLog");
  scanLog.innerHTML = ""; scanLog.style.display = "none";
  wrap.style.display = "block";

  try{
    const form = new FormData();
    if(folderPath) form.append("folder_path", folderPath);
    pendingFiles.forEach(f=> form.append("files", f, f.name));

    const res = await fetch(API + "/api/scan", { method:"POST", body: form, headers: authHeaders() });
    const data = await res.json();
    if(!res.ok){ throw new Error(data.detail || "Scan failed"); }

    sessionId = data.session_id;
    scannedFiles = data.files;
    scannedFiles.forEach(f=> log(scanLog, f.name + " → " + f.key, f.key==="UNSORTED"));

    rebuildGroups();
    renderGroups();
    step3.classList.remove("disabled");
    step4.classList.remove("disabled");
  } catch(err){
    log(scanLog, "Error: " + err.message, true);
    alert("Scan failed: " + err.message);
  } finally {
    wrap.style.display = "none";
    btn.disabled = false;
  }
});

function rebuildGroups(){
  const map = {};
  for(const f of scannedFiles){
    const k = f.key || "UNSORTED";
    if(!map[k]) map[k] = [];
    map[k].push(f);
  }
  groups = Object.keys(map).sort((a,b)=>{
    if(a==="UNSORTED") return 1;
    if(b==="UNSORTED") return -1;
    return a.localeCompare(b);
  }).map(k=>({key:k, files:map[k]}));
}

function renderGroups(){
  const container = document.getElementById("groupsContainer");
  container.innerHTML = "";
  const matched = scannedFiles.filter(f=>f.key!=="UNSORTED").length;
  document.getElementById("groupSummary").textContent =
    scannedFiles.length + " files scanned · " + groups.length + " shipment group(s) · " +
    matched + " matched automatically, " + (scannedFiles.length-matched) + " need review";

  groups.forEach(g=>{
    const card = document.createElement("div");
    card.className = "group" + (g.key==="UNSORTED" ? " unsorted" : "");
    const head = document.createElement("div");
    head.className = "group-head";
    head.innerHTML = '<span class="stamp">' + (g.key==="UNSORTED" ? "UNSORTED" : "HAWB " + g.key) + '</span>' +
      '<span class="group-count">' + g.files.length + ' file(s)</span>';
    card.appendChild(head);
    g.files.forEach(f=>{
      const row = document.createElement("div");
      row.className = "file-row";
      row.innerHTML =
        '<span class="ftype">' + f.ext + '</span>' +
        '<span class="fname" title="'+f.name+'">' + f.name + '</span>' +
        '<input type="text" class="keyinput" data-id="'+f.id+'" value="'+ (f.key==="UNSORTED"?"":f.key) +'" placeholder="UNSORTED">';
      card.appendChild(row);
    });
    container.appendChild(card);
  });

  container.querySelectorAll(".keyinput").forEach(inp=>{
    inp.addEventListener("change", ()=>{
      const id = inp.getAttribute("data-id");
      const f = scannedFiles.find(x=>x.id===id);
      f.key = sanitizeKey(inp.value) || "UNSORTED";
      rebuildGroups();
      renderGroups();
    });
  });
}

// ---- build ----
document.getElementById("buildBtn").addEventListener("click", async ()=>{
  if(!commonName){ alert("Add a common name in Step 1 first."); return; }
  if(!sessionId){ alert("Scan documents first."); return; }
  const btn = document.getElementById("buildBtn");
  btn.disabled = true;
  const wrap = document.getElementById("buildProgressWrap");
  const buildLog = document.getElementById("buildLog");
  buildLog.innerHTML = ""; buildLog.style.display = "none";
  wrap.style.display = "block";

  try{
    const assignments = scannedFiles.map(f=>({id:f.id, key:f.key}));
    const res = await fetch(API + "/api/build", {
      method:"POST",
      headers:{"Content-Type":"application/json", ...authHeaders()},
      body: JSON.stringify({ session_id: sessionId, common_name: commonName, assignments })
    });
    const data = await res.json();
    if(!res.ok){ throw new Error(data.detail || "Build failed"); }

    (data.log||[]).forEach(l=> log(buildLog, l.msg, l.err));
    data.groups.forEach(g=> log(buildLog, "Folder " + g.key + " → " + g.merged_name + " (" + g.file_count + " source file(s))"));

    const link = document.getElementById("downloadLink");
    link.href = API + data.download_url;
    link.setAttribute("download", "shipments.zip");
    document.getElementById("resultSummary").textContent =
      data.groups.length + " subfolder(s), " + scannedFiles.length + " original file(s), " +
      data.groups.length + " merged PDF(s) — " + fmtBytes(data.zip_size);
    document.getElementById("resultBox").style.display = "block";
  } catch(err){
    log(buildLog, "Error: " + err.message, true);
    alert("Build failed: " + err.message);
  } finally {
    wrap.style.display = "none";
    btn.disabled = false;
  }
});

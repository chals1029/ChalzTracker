pub mod providers;
pub mod vault;

use axum::{body::{Body, Bytes}, extract::{DefaultBodyLimit, State}, http::{header, HeaderMap, Method, StatusCode, Uri}, response::{IntoResponse, Response}, routing::any, Router};
use base64::Engine;
use serde_json::{json, Value};
use std::{collections::HashMap, convert::Infallible, net::SocketAddr, path::PathBuf, sync::{Arc, Mutex}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tokio::sync::{broadcast, oneshot};
use vault::{ChalzVault, compute_smart_routing, serialize_account_for_client};

fn now() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64 }
fn text<'a>(v: &'a Value, k: &str) -> &'a str { v.get(k).and_then(Value::as_str).unwrap_or("") }
fn catalog() -> Value { serde_json::from_str(include_str!("provider_catalog.json")).expect("embedded provider catalog") }
pub(crate) fn data_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("CHALZTRACKER_HOME") { return Ok(path.into()); }
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(|p| PathBuf::from(p).join(".chalztracker")).ok_or_else(|| "Could not locate the home directory".into())
}
struct Session { public: Value, created: i64, browser: Option<Arc<providers::BrowserFlow>>, task: Option<tokio::task::AbortHandle>, label: String, tag: String, reauth: String }
type NativeRoute = Arc<dyn Fn(&str, &Value, &Value) -> Result<(), String> + Send + Sync>;
struct App { vault: Mutex<ChalzVault>, sessions: Mutex<HashMap<String, Session>>, refresh_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>, refresh_results: Mutex<HashMap<String,(u64,Vec<Value>)>>, client: reqwest::Client, events: broadcast::Sender<Value>, resources: PathBuf, dir: PathBuf, port: u16, window: Mutex<(bool,bool,String)>, notify: Arc<dyn Fn(Value) + Send + Sync>, native_route: NativeRoute, reset_wake: tokio::sync::Notify }
impl App {
    fn emit(&self, v: Value) { let _ = self.events.send(v); }
    fn payload(&self, alerts: Vec<Value>) -> Value {
        self.reset_wake.notify_one();
        let v = self.vault.lock().unwrap(); let mut accounts: Vec<_> = v.accounts.iter().map(|a| serialize_account_for_client(a, now())).collect();
        let recommendations = compute_smart_routing(&mut accounts, now()); accounts.sort_by_key(|a| !a["pinned"].as_bool().unwrap_or(false));
        let mut p = json!({"accounts":accounts,"recommendations":recommendations,"settings":v.settings,"providers":catalog()}); if !alerts.is_empty() { p["alerts"] = json!(alerts); } p
    }
    fn clean_sessions(&self) { let mut sessions = self.sessions.lock().unwrap(); sessions.retain(|_, s| { if now()-s.created > 600_000 { if let Some(t)=s.task.take() { t.abort(); } false } else { true } }); }
    fn alerts(&self, alerts: &[Value]) { for a in alerts { if self.events.receiver_count()==0 { (self.notify)(a.clone()); } else { let mut a=a.clone(); a["nativeSoundHandled"]=json!(false); self.emit(json!({"type":"alert","alert":a})); } } }
    async fn refresh_one(&self, id: &str, force_banked: bool) -> Result<Vec<Value>,String> {
        let version=self.refresh_results.lock().unwrap().get(id).map_or(0,|v|v.0); let lock={let mut locks=self.refresh_locks.lock().unwrap();locks.entry(id.to_owned()).or_insert_with(||Arc::new(tokio::sync::Mutex::new(()))).clone()}; let _guard=lock.lock().await;
        if let Some((generation,alerts))=self.refresh_results.lock().unwrap().get(id) {if *generation!=version {return Ok(alerts.clone());}}
        let mut account = match self.vault.lock().unwrap().get_account_by_id(id) { Some(a)=>a.clone(), None=>return Ok(vec![]) };
        let original_credentials=account["credentials"].clone();
        if force_banked { providers::invalidate_codex_banked_cache(&account); }
        let headers = kimi_headers(text(&account["credentials"],"deviceId"));
        let result = providers::fetch_provider_usage(&self.client, &mut account, &headers).await;
        let mut v = self.vault.lock().unwrap();
        if let Some(existing) = v.accounts.iter_mut().find(|a| text(a,"id")==id) { if existing["credentials"] != original_credentials { return Ok(vec![]); } for key in ["credentials","email","accountId","orgId","orgName","projectId","planType","planCheckedAt"] { if !account[key].is_null() { existing[key] = account[key].clone(); } } } else { return Ok(vec![]); }
        let alerts = match result { Ok(report)=>v.record_account_usage(id,Some(&report),None), Err(e)=>v.record_account_usage(id,None,Some(&e)) }.map_err(|e|e.to_string())?; drop(v); self.refresh_results.lock().unwrap().insert(id.to_owned(),(version+1,alerts.clone())); self.alerts(&alerts); Ok(alerts)
    }
    async fn refresh_accounts(&self, id: Option<&str>, force: bool) -> Result<Option<Value>,String> {
        let targets = { let v=self.vault.lock().unwrap(); if let Some(id)=id { if v.get_account_by_id(id).is_none() { return Ok(None); } vec![id.to_owned()] } else { v.accounts.iter().filter(|a| a["enabled"] != false && (force || a["lastReport"]["fetchedAt"].as_i64().map_or(true, |t| now()-t>50_000))).map(|a| text(a,"id").to_owned()).collect() } };
        use futures_util::StreamExt;
        let force_banked = force && id.is_some();
        let batches = futures_util::stream::iter(targets.into_iter().map(|account_id| async move {
            self.refresh_one(&account_id, force_banked).await
        })).buffer_unordered(4).collect::<Vec<_>>().await;
        let mut alerts = Vec::new();
        for batch in batches { alerts.extend(batch?); }
        Ok(Some(self.payload(alerts)))
    }
    async fn finalize(self: &Arc<Self>, id: &str, mut account: Value, report: Option<Value>) -> Result<Value,String> {
        let (label,tag,reauth,name,provider) = { let mut sessions=self.sessions.lock().unwrap(); let s=sessions.get_mut(id).ok_or("Sign-in session expired or not found.")?; if s.public["status"] != "pending" { return Err("Sign-in session is no longer pending.".into()); } s.public["status"]=json!("finalizing"); (s.label.clone(),s.tag.clone(),s.reauth.clone(),text(&s.public,"providerName").to_owned(),text(&s.public,"provider").to_owned()) };
        account["provider"]=json!(provider); account["providerName"]=json!(name); account["label"]=json!(label); account["tag"]=json!(tag); account["reauthAccountId"]=json!(reauth);
        let saved={ let mut v=self.vault.lock().unwrap(); v.upsert_account(&account).map_err(|e|e.to_string())?["account"].clone() };
        let aid=text(&saved,"id").to_owned();
        if let Some(r)=report { let alerts=self.vault.lock().unwrap().record_account_usage(&aid,Some(&r),None).map_err(|e|e.to_string())?; self.alerts(&alerts); } else { self.refresh_one(&aid,false).await?; }
        let session={ let mut sessions=self.sessions.lock().unwrap(); let s=sessions.get_mut(id).ok_or("Sign-in cancelled.")?; s.public["status"]=json!("complete"); s.public["accountId"]=saved["id"].clone(); s.public["accountLabel"]=saved["label"].clone(); s.browser=None; s.public.clone() };
        self.emit(json!({"type":"accounts_updated","accountId":aid,"label":saved["label"],"provider":provider})); Ok(session)
    }
}
fn kimi_headers(device: &str) -> reqwest::header::HeaderMap {
    use sha2::{Digest,Sha256};
    let host=sysinfo::System::host_name().filter(|s|!s.is_empty()).unwrap_or_else(||"chalztracker".into());
    let os=match std::env::consts::OS {"windows"=>"win32","macos"=>"darwin",other=>other}; let arch=match std::env::consts::ARCH {"x86_64"=>"x64","x86"=>"ia32","aarch64"=>"arm64",other=>other};
    let model=format!("{os} {arch}"); let version=sysinfo::System::kernel_version().unwrap_or_default(); let fallback=if device.is_empty() {let digest=Sha256::digest(host.as_bytes());digest[..16].iter().map(|b|format!("{b:02x}")).collect::<String>()}else{String::new()}; let id=if device.is_empty(){fallback.as_str()}else{device};
    let mut h=reqwest::header::HeaderMap::new(); for (key,value) in [("user-agent","KimiCLI/1.0.0"),("x-msh-platform","kimi_cli"),("x-msh-version","1.0.0"),("x-msh-device-name",host.as_str()),("x-msh-device-model",model.as_str()),("x-msh-os-version",version.as_str()),("x-msh-device-id",id)] { if let Ok(v)=value.parse() { h.insert(reqwest::header::HeaderName::from_static(key),v); } } h
}
fn answer(status: StatusCode, value: Value) -> Response { (status, [(header::CACHE_CONTROL,"no-store"),(header::X_CONTENT_TYPE_OPTIONS,"nosniff")], axum::Json(value)).into_response() }
fn error(status: StatusCode, message: &str) -> Response { answer(status,json!({"error":message})) }
fn merge(mut a: Value, b: Value) -> Value { if let (Some(a),Some(b))=(a.as_object_mut(),b.as_object()) { a.extend(b.clone()); } a }
fn open_browser(url: &str) { #[cfg(target_os="windows")] { let _=std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler",url]).spawn(); } #[cfg(target_os="macos")] { let _=std::process::Command::new("open").arg(url).spawn(); } #[cfg(all(unix,not(target_os="macos")))] { let _=std::process::Command::new("xdg-open").arg(url).spawn(); } }

pub struct BackendHandle { pub port: u16, shutdown: Option<oneshot::Sender<()>>, thread: Option<std::thread::JoinHandle<()>> }
impl Drop for BackendHandle { fn drop(&mut self) { if let Some(s)=self.shutdown.take() { let _=s.send(()); } if let Some(t)=self.thread.take() { let _=t.join(); } } }
pub fn start(notify: Arc<dyn Fn(Value) + Send + Sync>, native_route: NativeRoute) -> Result<BackendHandle,Box<dyn std::error::Error>> {
    let dir=data_dir().map_err(std::io::Error::other)?; let vault=ChalzVault::new(dir.clone())?; let client=providers::provider_client().map_err(std::io::Error::other)?;
    let resources=PathBuf::from(std::env::var_os("CHALZ_APP_RESOURCES").ok_or("CHALZ_APP_RESOURCES is not set")?);
    let listener=std::net::TcpListener::bind(("127.0.0.1",0))?; listener.set_nonblocking(true)?; let port=listener.local_addr()?.port();
    let (events,_)=broadcast::channel(256); let app=Arc::new(App { vault:Mutex::new(vault), sessions:Mutex::new(HashMap::new()), refresh_locks:Mutex::new(HashMap::new()), refresh_results:Mutex::new(HashMap::new()),client,events,resources,dir,port,window:Mutex::new((false,false,"dashboard".into())),notify,native_route,reset_wake:tokio::sync::Notify::new() });
    let (shutdown,rx)=oneshot::channel(); let thread=std::thread::spawn(move || { let rt=tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("backend runtime"); rt.block_on(async move { let listener=tokio::net::TcpListener::from_std(listener).expect("backend listener"); tokio::spawn(background(app.clone())); let router=Router::new().fallback(any(handle)).layer(DefaultBodyLimit::max(4*1024*1024*4/3+1024)).with_state(app); tokio::select! { _=rx=>{}, _=async { let _=axum::serve(listener,router.into_make_service_with_connect_info::<SocketAddr>()).await; }=>{} } }); });
    Ok(BackendHandle { port, shutdown:Some(shutdown), thread:Some(thread) })
}
async fn handle(State(app): State<Arc<App>>, method: Method, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    let origin=format!("http://127.0.0.1:{}",app.port); let host=format!("127.0.0.1:{}",app.port);
    if headers.get(header::HOST).and_then(|v|v.to_str().ok()) != Some(host.as_str()) || headers.get(header::ORIGIN).is_some_and(|v|v.to_str().ok()!=Some(origin.as_str())) { return error(StatusCode::FORBIDDEN,"Forbidden"); }
    if uri.authority().is_some() || uri.scheme().is_some() { return error(StatusCode::BAD_REQUEST,"Bad request"); }
    if method!=Method::GET && (headers.get(header::ORIGIN).and_then(|v|v.to_str().ok())!=Some(origin.as_str()) || (method!=Method::DELETE && headers.get(header::CONTENT_TYPE).and_then(|v|v.to_str().ok()).and_then(|v|v.split(';').next()).map(str::trim).map(str::to_ascii_lowercase).as_deref()!=Some("application/json"))) { return error(StatusCode::FORBIDDEN,"Forbidden"); }
    let path=uri.path(); let max=if path=="/api/appearance" { 4*1024*1024*4/3+1024 } else { 16384 }; if body.len()>max { return error(StatusCode::PAYLOAD_TOO_LARGE,"Request too large."); }
    let b=if method!=Method::GET && method!=Method::DELETE && !body.is_empty() { match serde_json::from_slice::<Value>(&body) { Ok(v) if v.is_object()=>v, _=>return error(StatusCode::BAD_REQUEST,"Invalid request.") } } else { json!({}) };
    let ok=StatusCode::OK;
    match (method.as_str(),path) {
        ("GET","/api/providers")=>answer(ok,json!({"providers":catalog()})),
        ("GET","/api/accounts")=>match app.refresh_accounts(None,false).await {Ok(Some(p))=>answer(ok,p),_=>error(StatusCode::INTERNAL_SERVER_ERROR,"Request failed.")},
        ("POST","/api/accounts/refresh")=>match app.refresh_accounts(if text(&b,"id").is_empty(){None}else{Some(text(&b,"id"))},true).await { Ok(Some(p))=>answer(ok,p),Ok(None)=>answer(StatusCode::NOT_FOUND,merge(json!({"error":"Account not found."}),app.payload(vec![]))),Err(_)=>error(StatusCode::INTERNAL_SERVER_ERROR,"Request failed.") },
        ("POST","/api/accounts/redeem-reset")=>redeem(&app,text(&b,"id")).await,
        ("POST","/api/alerts/test")=>test_alert(&app,&b),
        ("GET","/api/analytics")=>{ let v=app.vault.lock().unwrap(); answer(ok,json!({"snapshots":v.snapshots,"events":v.events.iter().rev().collect::<Vec<_>>(),"settings":v.settings})) },
        ("POST","/api/settings")=>{ let r=app.vault.lock().unwrap().update_settings(&b); match r { Ok(v)=>answer(ok,json!({"ok":true,"settings":v})),Err(_)=>error(StatusCode::INTERNAL_SERVER_ERROR,"Request failed.") } },
        ("GET","/api/appearance")=>match read_appearance(&app.dir) { Ok(v)=>answer(ok,v),Err(_)=>error(StatusCode::INTERNAL_SERVER_ERROR,"Request failed.") },
        ("POST","/api/appearance")=>match save_appearance(&app.dir,&b) { Ok(())=>answer(ok,json!({"ok":true})),Err(e)=>error(StatusCode::BAD_REQUEST,&e) },
        ("GET","/api/window/events")=>{ use futures_util::StreamExt; let (top,tray,_) = app.window.lock().unwrap().clone(); let initial=futures_util::stream::once(async move { Ok::<_,Infallible>(format!("data: {}\n\n",json!({"type":"state","topmost":top,"tray":tray}))) }); let stream=tokio_stream::wrappers::BroadcastStream::new(app.events.subscribe()).filter_map(|x| async move { x.ok().map(|v|Ok::<_,Infallible>(format!("data: {}\n\n",v))) }); return Response::builder().status(200).header(header::CONTENT_TYPE,"text/event-stream; charset=utf-8").header(header::CACHE_CONTROL,"no-store").header(header::X_CONTENT_TYPE_OPTIONS,"nosniff").body(Body::from_stream(initial.chain(stream))).unwrap(); },
        ("GET","/api/window")=>{ let (top,tray,_)=app.window.lock().unwrap().clone(); answer(ok,json!({"topmost":top,"tray":tray,"clients":app.events.receiver_count()})) },
        ("POST","/api/window")=>window_transition(&app,&b),
        ("GET","/api/tray")=>{let w=app.window.lock().unwrap();answer(ok,json!({"active":w.1,"topmost":w.0}))},
        ("POST","/api/tray")=>tray_transition(&app,&b),
        ("POST","/api/accounts/start")=>start_auth(app,&b).await,
        ("GET","/api/accounts/auth-status")=>{app.clean_sessions();let id=query_param(&uri,"id");let session=app.sessions.lock().unwrap().get(&id).map(|s|s.public.clone());match session {Some(s) if s["status"]=="complete"=>answer(ok,merge(json!({"session":s}),app.payload(vec![]))),Some(s)=>answer(ok,json!({"session":s})),None=>error(StatusCode::NOT_FOUND,"Sign-in session expired or not found.")}},
        ("POST","/api/accounts/cancel")=>{if let Some(mut s)=app.sessions.lock().unwrap().remove(text(&b,"id")){if let Some(t)=s.task.take(){t.abort();}}answer(ok,json!({"ok":true}))},
        ("POST","/api/accounts/open-url")=>{let u=app.sessions.lock().unwrap().get(text(&b,"id")).map(|s|text(&s.public,"authUrl").to_owned()).unwrap_or_default();if u.is_empty(){error(StatusCode::NOT_FOUND,"No active browser URL for this sign-in session.")}else{open_browser(&u);answer(ok,json!({"ok":true}))}},
        ("POST","/api/accounts/complete")=>{let id=text(&b,"id");let (flow,completed)={let sessions=app.sessions.lock().unwrap();match sessions.get(id){Some(s)=>(s.browser.clone(),if s.public["status"]=="complete" {Some(s.public.clone())}else{None}),None=>(None,None)}};if let Some(s)=completed{return answer(ok,merge(json!({"session":s}),app.payload(vec![])));} match flow { Some(f)=>match providers::parse_manual_auth_input(text(&b,"code")) { Ok((Some(code),state))=>match providers::complete_browser_flow(&app.client,&f,&code,state.as_deref(),true).await {Ok(a)=>match app.finalize(id,a,None).await {Ok(s)=>{if let Some(task)=app.sessions.lock().unwrap().get_mut(id).and_then(|s|s.task.take()){task.abort();}answer(ok,merge(json!({"session":s}),app.payload(vec![])))},Err(e)=>error(StatusCode::BAD_REQUEST,&e)},Err(e)=>error(StatusCode::BAD_REQUEST,&e)},Ok(_)=>error(StatusCode::BAD_REQUEST,"Please enter an authorization code."),Err(e)=>error(StatusCode::BAD_REQUEST,&e)}, None=>error(StatusCode::BAD_REQUEST,"This sign-in flow completes automatically in your browser.") }},
        _ if path.starts_with("/api/accounts/") && method==Method::PATCH => {let id=percent_encoding::percent_decode_str(&path[14..]).decode_utf8_lossy().to_string();let r=app.vault.lock().unwrap().update_account_meta(&id,&b);match r {Ok(Some(_))=>answer(ok,merge(json!({"ok":true}),app.payload(vec![]))),Ok(None)=>error(StatusCode::NOT_FOUND,"Account not found."),Err(_)=>error(StatusCode::INTERNAL_SERVER_ERROR,"Request failed.")}},
        _ if path.starts_with("/api/accounts/") && method==Method::DELETE => {let id=percent_encoding::percent_decode_str(&path[14..]).decode_utf8_lossy().to_string();let r=app.vault.lock().unwrap().remove_account(&id);match r {Ok(Some(a))=>answer(ok,merge(json!({"ok":true,"removedLabel":a["label"]}),app.payload(vec![]))),Ok(None)=>error(StatusCode::NOT_FOUND,"Account not found."),Err(_)=>error(StatusCode::INTERNAL_SERVER_ERROR,"Request failed.")}},
        _ if method==Method::GET => static_file(&app.resources,path),
        _=>error(StatusCode::NOT_FOUND,"Not found.")
    }
}
fn query_param(uri: &Uri, key: &str) -> String { url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes()).find(|(k,_)|k==key).map(|(_,v)|v.into_owned()).unwrap_or_default() }

fn session_error(app: &App, id: &str, message: &str) { if let Some(s)=app.sessions.lock().unwrap().get_mut(id) { s.public["status"]=json!("error"); s.public["error"]=json!(message); s.browser=None; } }
async fn start_auth(app: Arc<App>, b: &Value) -> Response {
    app.clean_sessions();
    let defs=catalog(); let provider=text(b,"provider");
    let def=match defs.as_array().unwrap().iter().find(|d|text(d,"id")==provider) { Some(v)=>v, None=>return error(StatusCode::BAD_REQUEST,"Unknown provider.") };
    let modes=def["modes"].as_array().unwrap(); let mode=modes.iter().find(|m|text(m,"id")==text(b,"mode")).unwrap_or(&modes[0]);
    let id=uuid::Uuid::new_v4().to_string(); let name=text(def,"name"); let mode_id=text(mode,"id");
    let mut public=json!({"id":id,"provider":provider,"providerName":name,"mode":mode_id,"status":"pending","authUrl":null,"userCode":null,"verificationUri":null,"instructions":"","acceptsManualCode":false,"manualInputPlaceholder":"","error":null,"accountId":null,"accountLabel":null});
    let session=Session { public:public.clone(), created:now(), browser:None, task:None, label:text(b,"label").trim().into(), tag:text(b,"tag").trim().into(), reauth:text(b,"reauthAccountId").into() };
    app.sessions.lock().unwrap().insert(id.clone(),session);
    if text(mode,"kind")=="api_key" {
        let result=providers::authorize_direct_key(&app.client,provider,text(b,"apiKey")).await;
        return match result { Ok((account,report))=>match app.finalize(&id,account,report).await { Ok(s)=>answer(StatusCode::OK,merge(json!({"session":s}),app.payload(vec![]))),Err(e)=>{app.sessions.lock().unwrap().remove(&id);error(StatusCode::BAD_REQUEST,&e)} }, Err(e)=>{app.sessions.lock().unwrap().remove(&id);error(StatusCode::BAD_REQUEST,&e)} };
    }
    if mode_id=="device" {
        let device=uuid::Uuid::new_v4().simple().to_string(); let headers=kimi_headers(&device);
        let flow=match providers::start_device_flow(&app.client,provider,&device,&headers).await { Ok(f)=>f,Err(e)=>{app.sessions.lock().unwrap().remove(&id);return error(StatusCode::BAD_REQUEST,&e)} };
        public=merge(public,flow.session()); let task_app=app.clone(); let task_id=id.clone();
        let task=tokio::spawn(async move { let mut flow=flow; let deadline=tokio::time::Instant::now()+Duration::from_secs(600); loop { tokio::time::sleep(Duration::from_secs(flow.interval_seconds())).await; if tokio::time::Instant::now()>=deadline {session_error(&task_app,&task_id,"Sign-in session expired.");break;} match providers::poll_device_flow(&task_app.client,&mut flow,&headers).await {Ok(providers::DevicePoll::Pending)=>{},Ok(providers::DevicePoll::Complete(a))=>{if let Err(e)=task_app.finalize(&task_id,a,None).await {session_error(&task_app,&task_id,&e);}break;},Err(e) if e=="Device authorization failed or expired." || e.starts_with("OpenAI device token exchange failed")=>{session_error(&task_app,&task_id,&e);break;},Err(_)=>{} } } });
        let mut sessions=app.sessions.lock().unwrap();let s=sessions.get_mut(&id).unwrap();s.public=public.clone();s.task=Some(task.abort_handle());
    } else if provider=="cursor" {
        let flow=providers::start_cursor_flow(); public=merge(public,flow.session()); let task_app=app.clone();let task_id=id.clone();
        let task=tokio::spawn(async move {let deadline=tokio::time::Instant::now()+Duration::from_secs(600);loop {tokio::time::sleep(Duration::from_millis(2200)).await;if tokio::time::Instant::now()>=deadline {session_error(&task_app,&task_id,"Sign-in session expired.");break;}match providers::poll_cursor_flow(&task_app.client,&flow).await {Ok(providers::DevicePoll::Complete(a))=>{if let Err(e)=task_app.finalize(&task_id,a,None).await {session_error(&task_app,&task_id,&e);}break;},Ok(providers::DevicePoll::Pending)|Err(_)=>{}}}});
        let mut sessions=app.sessions.lock().unwrap();let s=sessions.get_mut(&id).unwrap();s.public=public.clone();s.task=Some(task.abort_handle());
    } else {
        let (port,path)=match provider {"antigravity"=>(51121,"/oauth-callback"),"gemini-cli"=>(8085,"/oauth2callback"),"codex"=>(1455,"/auth/callback"),"claude"=>(54545,"/callback"),_=>{app.sessions.lock().unwrap().remove(&id);return error(StatusCode::BAD_REQUEST,"Unsupported sign-in mode.")} };
        let listener=if provider=="claude" && mode_id=="code" {None} else {match tokio::net::TcpListener::bind(("127.0.0.1",port)).await {Ok(l)=>Some(l),Err(_) if provider=="antigravity" || provider=="gemini-cli"=>tokio::net::TcpListener::bind(("127.0.0.1",0)).await.ok(),Err(_)=>None}};
        let redirect=if let Some(l)=&listener {if provider=="codex" || provider=="claude" {format!("http://localhost:{port}{path}")} else {format!("http://{}{}",l.local_addr().unwrap(),path)}} else if provider=="claude" {"https://platform.claude.com/oauth/code/callback".into()} else if provider=="codex" {format!("http://localhost:{port}{path}")} else {format!("http://127.0.0.1:{port}{path}")};
        let flow=match providers::start_browser_flow(provider,&redirect) {Ok(f)=>Arc::new(f),Err(e)=>{app.sessions.lock().unwrap().remove(&id);return error(StatusCode::BAD_REQUEST,&e)}};
        public=merge(public,flow.session());public["mode"]=json!(mode_id);
        public["manualInputPlaceholder"]=json!(if provider=="claude" {"Paste the code#state string or callback URL"}else{"Paste the callback URL or authorization code"}); public["instructions"]=json!(if listener.is_some(){"Complete sign-in in your browser. Completion will be detected automatically, or paste the callback URL below."}else{"Complete sign-in in your browser, then paste the authorization code or callback URL below."});
        let task=listener.map(|listener| {let task_app=app.clone();let task_id=id.clone();let flow=flow.clone();tokio::spawn(async move {oauth_listener(task_app,task_id,flow,listener,path).await}) });
        let mut sessions=app.sessions.lock().unwrap();let s=sessions.get_mut(&id).unwrap();s.public=public.clone();s.browser=Some(flow);s.task=task.map(|t|t.abort_handle());
    }
    if b["openBrowser"]!=false && !text(&public,"authUrl").is_empty() {open_browser(text(&public,"authUrl"));}
    answer(StatusCode::OK,merge(json!({"session":public}),app.payload(vec![])))
}
async fn oauth_listener(app: Arc<App>, id:String, flow:Arc<providers::BrowserFlow>, listener:tokio::net::TcpListener, path:&'static str) {
    use tokio::io::{AsyncReadExt,AsyncWriteExt};
    let timeout=tokio::time::sleep(Duration::from_secs(600));tokio::pin!(timeout);
    loop { let accepted=tokio::select! { _=&mut timeout=>{session_error(&app,&id,"Sign-in session expired.");return},v=listener.accept()=>v }; let (mut socket,peer)=match accepted {Ok(v)=>v,Err(_)=>return};if !peer.ip().is_loopback(){continue;}
        let mut bytes=[0u8;8192];let n=match tokio::time::timeout(Duration::from_secs(3),socket.read(&mut bytes)).await {Ok(Ok(n))=>n,_=>continue};let req=String::from_utf8_lossy(&bytes[..n]);let target=req.lines().next().and_then(|line|{let mut p=line.split_whitespace();if p.next()==Some("GET"){p.next()}else{None}}).unwrap_or("");
        let parsed=match url::Url::parse(&format!("http://127.0.0.1{target}")) {Ok(v) if v.path()==path=>v,_=>{let _=socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;continue}};
        let code=parsed.query_pairs().find(|(k,_)|k=="code").map(|(_,v)|v.into_owned());let state=parsed.query_pairs().find(|(k,_)|k=="state").map(|(_,v)|v.into_owned());
        let name=app.sessions.lock().unwrap().get(&id).map(|s|text(&s.public,"providerName").to_owned()).filter(|n|!n.is_empty()).map_or_else(||"the account".to_owned(),|n|format!("your {n} account"));
        if !flow.matches_state(state.as_deref()) {let _=socket.write_all(&callback_page(CallbackOutcome::Expired,"This sign-in link has expired","It belongs to an earlier or different sign-in attempt, so ChalzTracker ignored it.","If ChalzTracker is still waiting, finish signing in from the browser tab it opened, or start adding the account again.")).await;continue;}
        let provider_error=parsed.query_pairs().find(|(k,_)|k=="error").map(|(_,v)|v.into_owned());
        let result=match (code,provider_error) {
            (Some(code),_)=>providers::complete_browser_flow(&app.client,&flow,&code,state.as_deref(),false).await,
            (None,Some(e)) if e=="access_denied"=>Err("Access was denied, or the sign-in was cancelled.".into()),
            (None,Some(e))=>Err(parsed.query_pairs().find(|(k,_)|k=="error_description").map(|(_,v)|v.into_owned()).unwrap_or(e)),
            (None,None)=>Err("Authorization was not completed.".into()),
        };
        let result=match result {Ok(account)=>app.finalize(&id,account,None).await,Err(e)=>Err(e)};
        let page=match result {
            Ok(session)=>{let label=text(&session,"accountLabel");callback_page(CallbackOutcome::Success,"You're signed in",&if label.is_empty(){format!("ChalzTracker connected {name}.")}else{format!("{label} is connected to ChalzTracker.")},"You can close this tab and go back to the app.")},
            Err(e)=>{session_error(&app,&id,&e);callback_page(CallbackOutcome::Failed,"Sign-in didn't finish",&format!("ChalzTracker couldn't connect {name}. {e}"),"Close this tab, then add the account again in ChalzTracker.")},
        };
        let _=socket.write_all(&page).await;return;
    }
}

#[derive(Clone,Copy)]
enum CallbackOutcome { Success, Failed, Expired }

const CALLBACK_PAGE: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><title>{{TITLE}} · ChalzTracker</title>
<style>
:root{--bg:#0d0d0f;--surface:#141417;--border:rgba(255,255,255,.08);--strong:rgba(255,255,255,.15);--text:#f4f4f6;--muted:#8e8e93;--brand:#30d158;--tone:{{TONE}};--tone-soft:{{TONE_SOFT}}}
@media (prefers-color-scheme:light){:root{--bg:#f5f5f7;--surface:#fff;--border:rgba(0,0,0,.08);--strong:rgba(0,0,0,.14);--text:#1d1d1f;--muted:#6e6e73}}
*{box-sizing:border-box;margin:0}
body{min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(600px 320px at 50% 0%,var(--tone-soft),transparent 70%),var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:440px;padding:32px;border:1px solid var(--border);border-radius:16px;background:var(--surface);box-shadow:0 20px 48px rgba(0,0,0,.35)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:28px;font-weight:600;letter-spacing:-.01em}
.brand svg{width:28px;height:28px}
.brand span{color:var(--muted);font-weight:500}
.status{display:grid;place-items:center;width:52px;height:52px;margin-bottom:20px;border-radius:14px;background:var(--tone-soft);color:var(--tone)}
.status svg{width:26px;height:26px}
h1{font-size:22px;line-height:1.25;letter-spacing:-.02em;margin-bottom:10px}
.detail{color:var(--text);opacity:.88;overflow-wrap:anywhere}
.hint{margin-top:18px;padding-top:18px;border-top:1px solid var(--border);color:var(--muted);font-size:14px}
</style></head>
<body><main role="status">
<div class="brand"><svg viewBox="0 0 36 36" fill="none" aria-hidden="true"><rect x="1" y="1" width="34" height="34" rx="9" fill="var(--bg)" stroke="var(--strong)" stroke-width="1.5"/><path d="M23.5 11.5H14.8C12.7 11.5 11 13.2 11 15.3V20.7C11 22.8 12.7 24.5 14.8 24.5H23.5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M16.5 18H25.5" stroke="var(--brand)" stroke-width="2.8" stroke-linecap="round"/><circle cx="25.5" cy="11.5" r="1.85" fill="var(--brand)"/></svg>Chalz<span>Tracker</span></div>
<div class="status" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">{{ICON}}</svg></div>
<h1>{{TITLE}}</h1>
<p class="detail">{{DETAIL}}</p>
<p class="hint">{{HINT}}</p>
</main></body></html>"#;

fn callback_page(outcome:CallbackOutcome, title:&str, detail:&str, hint:&str) -> Vec<u8> {
    let (status,tone,soft,icon)=match outcome {
        CallbackOutcome::Success=>("200 OK","#30d158","rgba(48,209,88,.14)",r#"<path d="M5 12.5l4.5 4.5L19 7.5"/>"#),
        CallbackOutcome::Failed=>("400 Bad Request","#ef4444","rgba(239,68,68,.14)",r#"<path d="M7 7l10 10M17 7L7 17"/>"#),
        CallbackOutcome::Expired=>("400 Bad Request","#f5a623","rgba(245,166,35,.14)",r#"<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>"#),
    };
    let html=CALLBACK_PAGE.replace("{{TONE}}",tone).replace("{{TONE_SOFT}}",soft).replace("{{ICON}}",icon).replace("{{TITLE}}",&escape_html(title)).replace("{{DETAIL}}",&escape_html(detail)).replace("{{HINT}}",&escape_html(hint));
    let mut response=format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",html.len()).into_bytes();
    response.extend_from_slice(html.as_bytes()); response
}

fn escape_html(s:&str) -> String {
    let mut out=String::with_capacity(s.len());
    for c in s.chars() { match c {'&'=>out.push_str("&amp;"),'<'=>out.push_str("&lt;"),'>'=>out.push_str("&gt;"),'"'=>out.push_str("&quot;"),'\''=>out.push_str("&#39;"),_=>out.push(c)} }
    out
}

fn read_appearance(dir:&std::path::Path) -> std::io::Result<Value> { match std::fs::read(dir.join("appearance.json")) { Ok(data)=>serde_json::from_slice(&data).map_err(std::io::Error::other),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(json!({"opacity":100,"image":null})),Err(e)=>Err(e) } }
fn save_appearance(dir:&std::path::Path, patch:&Value) -> Result<(),String> {
    if let Some(v)=patch.get("opacity") {if !v.as_u64().is_some_and(|x|x<=100){return Err("Invalid background settings.".into());}}
    if let Some(v)=patch.get("widgetGroupByProvider") {if !v.is_boolean(){return Err("Invalid background settings.".into());}}
    if let Some(v)=patch.get("ui") {let choices=[("surface",&["obsidian","midnight","graphite","light"][..]),("accent",&["emerald","cyan","violet","amber","rose","mono"][..]),("cols",&["1","2","3"][..]),("density",&["compact","comfortable","spacious"][..]),("barStyle",&["sleek","bold","glow"][..])];if !v.is_object() || choices.iter().any(|(k,vals)|!vals.contains(&text(v,k))) || ["showRouter","showKpis","showPace"].iter().any(|k|!v[*k].is_boolean()) || v.as_object().unwrap().keys().any(|k|!choices.iter().any(|(name,_)|name==k) && !["showRouter","showKpis","showPace"].contains(&k.as_str())) {return Err("Invalid background settings.".into());}}
    if let Some(v)=patch.get("image") {if !v.is_null() {let image=v.as_str().ok_or("Invalid background settings.")?;let (kind,data)=image.split_once(";base64,").ok_or("Invalid background settings.")?;let bytes=base64::engine::general_purpose::STANDARD.decode(data).map_err(|_|"Invalid background settings.")?;let valid=bytes.len()<=4*1024*1024 && match kind {"data:image/png"=>bytes.starts_with(b"\x89PNG\r\n\x1a\n"),"data:image/jpeg"=>bytes.starts_with(&[0xff,0xd8,0xff]),"data:image/webp"=>bytes.len()>=12 && &bytes[..4]==b"RIFF" && &bytes[8..12]==b"WEBP",_=>false};if !valid{return Err("Invalid background settings.".into());}}}
    let mut appearance=read_appearance(dir).map_err(|e|e.to_string())?;for key in ["opacity","image","ui","widgetGroupByProvider"] {if let Some(value)=patch.get(key) {appearance[key]=value.clone();}}
    std::fs::create_dir_all(dir).map_err(|e|e.to_string())?;let mut tmp=tempfile::NamedTempFile::new_in(dir).map_err(|e|e.to_string())?;serde_json::to_writer(&mut tmp,&appearance).map_err(|e|e.to_string())?;tmp.persist(dir.join("appearance.json")).map_err(|e|e.to_string())?;Ok(())
}
fn static_file(root:&std::path::Path,path:&str) -> Response {
    let (name,mime)=match path {"/"|"/index.html"=>("index.html","text/html; charset=utf-8"),"/app.js"=>("app.js","text/javascript; charset=utf-8"),"/styles.css"=>("styles.css","text/css; charset=utf-8"),"/manifest.webmanifest"=>("manifest.webmanifest","application/manifest+json; charset=utf-8"),"/favicon.ico"|"/assets/favicon.ico"=>("assets/favicon.ico","image/x-icon"),p if ["/assets/chalz-logo.svg","/assets/chalz-wordmark.svg","/assets/openai.svg","/assets/antigravity.svg","/assets/cursor.svg","/assets/anthropic.svg","/assets/google.svg","/assets/gemini.svg","/assets/github.svg","/assets/kimi.svg","/assets/xai.svg","/assets/zai.svg","/assets/minimax.svg"].contains(&p)=>( &p[1..],"image/svg+xml"),p if ["/assets/chalz-icon-32.png","/assets/chalz-icon-192.png","/assets/icons/antigravity.png","/assets/icons/codex.png","/assets/icons/openai.png","/assets/icons/claude.png","/assets/icons/cursor.png","/assets/icons/gemini-cli.png","/assets/icons/copilot.png","/assets/icons/kimi.png","/assets/icons/xai.png","/assets/icons/zai.png","/assets/icons/minimax.png"].contains(&p)=>( &p[1..],"image/png"),_=>return (StatusCode::NOT_FOUND,"Not found").into_response()};
    match std::fs::read(root.join(name)) {Ok(data)=>Response::builder().status(200).header(header::CONTENT_TYPE,mime).header(header::CACHE_CONTROL,"no-store").header(header::X_CONTENT_TYPE_OPTIONS,"nosniff").header(header::CONTENT_SECURITY_POLICY,"default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'").header(header::REFERRER_POLICY,"no-referrer").body(Body::from(data)).unwrap(),Err(e)=>(if e.kind()==std::io::ErrorKind::NotFound {StatusCode::NOT_FOUND}else{StatusCode::INTERNAL_SERVER_ERROR},"Unable to read application file").into_response()}
}

async fn redeem(app:&Arc<App>,id:&str)->Response {
    let lock={let mut locks=app.refresh_locks.lock().unwrap();locks.entry(id.to_owned()).or_insert_with(||Arc::new(tokio::sync::Mutex::new(()))).clone()};let _guard=lock.lock().await; let mut account=match app.vault.lock().unwrap().get_account_by_id(id) {Some(a)=>a.clone(),None=>return error(StatusCode::NOT_FOUND,"Account not found.")};
    if text(&account,"provider")!="codex" {return error(StatusCode::BAD_REQUEST,"Banked reset redemption is not supported for this provider.");}
    let headers=kimi_headers(text(&account["credentials"],"deviceId"));
    if let Err(e)=providers::ensure_fresh_credentials(&app.client,&mut account,&headers).await {return error(StatusCode::BAD_REQUEST,&e);}
    let report=match providers::redeem_codex_banked_reset(&app.client,&mut account).await {Ok(r)=>r,Err(e)=>return error(StatusCode::BAD_REQUEST,&e)};
    let result={let mut v=app.vault.lock().unwrap();if let Some(existing)=v.accounts.iter_mut().find(|a|text(a,"id")==id){existing["credentials"]=account["credentials"].clone();}v.record_account_usage(id,Some(&report),None)};
    match result {Ok(alerts)=>{app.alerts(&alerts);app.emit(json!({"type":"accounts_updated","reason":"banked_redeemed","accountId":id}));answer(StatusCode::OK,merge(json!({"ok":true}),app.payload(alerts)))},Err(_)=>error(StatusCode::INTERNAL_SERVER_ERROR,"Request failed.")}
}
fn test_alert(app:&App,body:&Value)->Response {
    let v=app.vault.lock().unwrap();let requested=text(body,"provider");let account=v.accounts.iter().filter(|a|a["enabled"]!=false).find(|a|!requested.is_empty() && text(a,"provider")==requested).or_else(||v.accounts.iter().find(|a|a["enabled"]!=false));
    let provider=if !requested.is_empty(){requested}else{account.map(|a|text(a,"provider")).unwrap_or("codex")};let defs=catalog();let default_label=defs.as_array().unwrap().iter().find(|d|text(d,"id")==provider).map(|d|text(d,"name")).unwrap_or("Codex");let label=account.map(|a|vault::clean_display_label(text(a,"label"),text(a,"provider"))).unwrap_or_else(||default_label.to_owned());
    let window=account.and_then(|a|a["lastReport"]["limits"].as_array()).and_then(|l|l.first()).map(|l|text(l,"label")).filter(|s|!s.is_empty()).unwrap_or("5-Hour Window");let level=if ["reset","warn","crit"].contains(&text(body,"level")){text(body,"level")}else{"reset"};let pack=if text(body,"soundPack").is_empty(){text(&v.settings,"soundPack")}else{text(body,"soundPack")};let sound=body["sound"].as_bool().unwrap_or(v.settings["soundEnabled"]!=false && pack!="off");
    let (title,message)=match level {"warn"=>(format!("{label} Warning (84%)"),format!("{window} is at 84% used (preview notification).")),"crit"=>(format!("{label} Critical (96%)"),format!("{window} is at 96% used — switch account soon.")),_=>(format!("{label} — Usage Reset!"),"Your usage has been reset.".into())};
    let alert=json!({"kind":level,"level":level,"provider":provider,"accountId":account.map(|a|a["id"].clone()),"accountLabel":label,"windowLabel":window,"sound":sound,"soundPack":pack,"title":title,"body":message});drop(v);app.alerts(std::slice::from_ref(&alert));answer(StatusCode::OK,json!({"ok":true,"alert":alert}))
}
async fn background(app:Arc<App>) {
    let mut last_tray=now(); let mut attempts:HashMap<(String,i64),(u8,i64)>=HashMap::new();
    loop {
        app.clean_sessions(); let at=now(); let mut next=at+60_000; let mut due=std::collections::HashSet::new();
        { let v=app.vault.lock().unwrap(); for a in &v.accounts { if a["enabled"]==false {continue;} if let Some(limits)=a["lastReport"]["limits"].as_array() { for l in limits { if l["usedFraction"].as_f64().unwrap_or(0.0)<0.01 {continue;} let reset=l["resetsAt"].as_i64().or_else(||l["resetsAt"].as_str().and_then(|s|chrono::DateTime::parse_from_rfc3339(s).ok().map(|d|d.timestamp_millis()))); if let Some(t)=reset {if t<at-45_000 {continue;}let key=(text(a,"id").to_owned(),t);let (count,last)=attempts.get(&key).copied().unwrap_or((0,0));if count>=2 {continue;}let deadline=(t+3500).max(last+3500);if deadline<=at {attempts.insert(key.clone(),(count+1,at));due.insert(key.0);}else{next=next.min(deadline);}} } } } }
        if attempts.len()>200 {attempts.clear();} if !due.is_empty() {for id in due {let _=app.refresh_one(&id,false).await;}app.emit(json!({"type":"accounts_updated","reason":"window_reset"}));continue;}
        let tray=app.window.lock().unwrap().1; if tray && at-last_tray>=60_000 {last_tray=at;let _=app.refresh_accounts(None,false).await;continue;} if tray {next=next.min(last_tray+60_000);}
        let delay=Duration::from_millis((next-now()).max(1) as u64);tokio::select! { _=tokio::time::sleep(delay)=>{}, _=app.reset_wake.notified()=>{} }
    }
}

fn window_transition(app:&App,body:&Value)->Response {
    let mut current=app.window.lock().unwrap(); let mut proposed=current.clone();let action=text(body,"action").trim().to_ascii_lowercase();let mut announce=false;
    let response=match action.as_str() {
        "focus"=>json!({"ok":true,"topmost":proposed.0,"tray":proposed.1}),
        "hide"=>{proposed.1=true;json!({"ok":true,"hidden":true,"tray":true})},
        "topmost"=>{proposed.0=body["topmost"].as_bool().unwrap_or(!proposed.0);if ["dashboard","widget","pill"].contains(&text(body,"mode")){proposed.2=text(body,"mode").into();}announce=true;json!({"ok":true,"topmost":proposed.0})},
        _=>{let mode=if ["dashboard","widget","pill"].contains(&text(body,"mode")){text(body,"mode")}else{"dashboard"};proposed.2=mode.into();if mode=="dashboard" && body["keepTopmost"]!=true && proposed.0 {proposed.0=false;announce=true;}json!({"ok":true,"mode":mode,"topmost":proposed.0})}
    };
    if (app.native_route)("/api/window",body,&response).is_err(){return error(StatusCode::SERVICE_UNAVAILABLE,"Could not update the native window.");} *current=proposed;if announce {app.emit(json!({"type":"topmost","topmost":current.0}));}app.reset_wake.notify_one();answer(StatusCode::OK,response)
}
fn tray_transition(app:&App,body:&Value)->Response {
    if !cfg!(target_os="windows") {return error(StatusCode::BAD_REQUEST,"Windows system tray is only supported on Windows.");}
    let mut current=app.window.lock().unwrap();let action=text(body,"action").trim().to_ascii_lowercase();if action=="status" {return answer(StatusCode::OK,json!({"active":current.1,"topmost":current.0}));}
    let active=!(action=="stop" || (action=="toggle" && current.1 && body["hideWindow"]!=true));let hidden=active && body["hideWindow"]!=false;
    let response=if active {json!({"active":true,"hidden":hidden,"message":if hidden {"Minimized to Windows system tray. Left-click the tray icon anytime to toggle ChalzTracker."}else{"Pinned to Windows system tray."}})} else {json!({"active":false,"message":"Removed from Windows system tray."})};
    if (app.native_route)("/api/tray",body,&response).is_err(){return error(StatusCode::SERVICE_UNAVAILABLE,"Could not initialize Windows system tray icon.");}current.1=active;app.reset_wake.notify_one();answer(StatusCode::OK,response)
}

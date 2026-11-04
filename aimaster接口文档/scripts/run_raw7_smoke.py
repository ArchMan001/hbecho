#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI Master raw7：补测分页、回复、空数据、置顶、无效链接与异步。"""
from __future__ import annotations
import hashlib, json, os, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone

ROOT="/Users/liuxuekui/Documents/hbecho"
ENV_PATH=os.path.join(ROOT,".env")
OUT_DIR=os.path.join(ROOT,"aimaster接口文档","测试结果","raw7-2026-10-28")
os.makedirs(OUT_DIR,exist_ok=True)
BUDGET=70; MAX_ATTEMPTS=3; POLL_INTERVAL=10; MAX_POLLS=6

def load_env(path):
    env={}
    for line in open(path,encoding="utf-8"):
        line=line.strip()
        if not line or line.startswith("#") or "=" not in line: continue
        k,v=line.split("=",1); env[k.strip()]=v.strip().strip("'\"")
    return env
ENV=load_env(ENV_PATH)
API_KEY=ENV.get("AIMASTER_API_KEY","")
if not API_KEY: raise SystemExit("缺少 API Key")
if ENV.get("AIMASTER_ENABLED","false").lower()!="true": raise SystemExit("AIMASTER_ENABLED 不是 true")
BASE_URL=(ENV.get("AIMASTER_BASE_URL") or "https://openapi.fieldshortcut.com").rstrip("/")
HEADERS={"Content-Type":"application/json","X-Api-Key":API_KEY}
SAFE={"Content-Type":"application/json"}
calls=0; results={}

def now(): return datetime.now(timezone.utc).isoformat()
def sha(b): return hashlib.sha256(b).hexdigest()

def http(method,url,params=None,payload=None,headers=None,timeout=300):
    if params: url=f"{url}?{urllib.parse.urlencode(params)}"
    data=json.dumps(payload).encode() if payload is not None else None
    req=urllib.request.Request(url,data=data,headers=headers or HEADERS,method=method)
    try:
        with urllib.request.urlopen(req,timeout=timeout) as r:
            raw=r.read(); return r.status,raw,None
    except urllib.error.HTTPError as e:
        return e.code,e.read(),None
    except Exception as e:
        return None,b"",f"{type(e).__name__}: {e}"

def classify(status,body,err):
    if err: return "transport_error"
    if status in (401,403): return "auth_error"
    if status in (400,422): return "input_error"
    if status==404: return "not_found"
    if status==429: return "rate_limited"
    if status and 500<=status<600: return "server_error"
    if not isinstance(body,dict): return "schema_error"
    data=body.get("data")
    if not isinstance(data,dict): return "schema_error"
    st=data.get("status")
    if st=="succeeded": return "success"
    if st=="failed": return "provider_failed"
    if st in ("pending","running","queued"): return "pending"
    return "schema_error"

def brief(body):
    if not isinstance(body,dict): return {}
    data=body.get("data")
    if not isinstance(data,dict): return {"code":body.get("code"),"message":str(body.get("message"))[:200]}
    out={"code":body.get("code"),"action":data.get("action"),"status":data.get("status"),"task_id":data.get("task_id")}
    r=data.get("result")
    if isinstance(r,dict):
        out["keys"]=len(r)
        inner=r.get("result")
        if isinstance(inner,list):
            out["items"]=len(inner); out["has_more"]=r.get("has_more")
        for k in ("max_cursor","cursor"):
            if k in r: out[k]=r.get(k)
        for k in ("total","reply_page_count","play_number","duration_number","share_number","like_number","comment_number","collect_number"):
            if k in r: out[k]=r.get(k)
    elif isinstance(r,list):
        out["items"]=len(r)
    if data.get("error") is not None: out["error"]=str(data.get("error"))[:300]
    return out

def save(rec,name):
    json.dump(rec,open(os.path.join(OUT_DIR,name),"w",encoding="utf-8"),ensure_ascii=False,indent=2)

def post(cid,platform,action,path,payload,mode,attempt,key=None):
    global calls
    if calls>=BUDGET: raise SystemExit("预算上限")
    calls+=1
    rec={"case":cid,"platform":platform,"action":action,"mode":mode,"attempt":attempt,"endpoint":path,
         "request":{"url":f"{BASE_URL}{path}","params":{"async":"false" if mode=="sync" else "true"},
                    "method":"POST","headers":SAFE,"body":payload},
         "started_at":now(),"http_status":None,"response_body":None,"response_bytes":None,
         "response_sha256":None,"transport_error":None,"elapsed_seconds":None,"classification":None}
    t0=time.time()
    hdrs=dict(HEADERS)
    if key: hdrs["X-Api-Key"]=key
    status,raw,err=http("POST",f"{BASE_URL}{path}",{"async":"false" if mode=="sync" else "true"},payload,hdrs)
    if err: rec["transport_error"]=err
    else:
        rec["http_status"]=status; rec["response_bytes"]=len(raw); rec["response_sha256"]=sha(raw)
        try: rec["response_body"]=json.loads(raw.decode("utf-8"))
        except Exception: rec["response_body"]={"_unparsable":raw.decode("utf-8","replace")[:2000]}
    rec["elapsed_seconds"]=round(time.time()-t0,2)
    rec["classification"]=classify(rec["http_status"],rec["response_body"],rec["transport_error"])
    save(rec,f"{cid}-{platform}-{action}-{mode}-attempt{attempt}.json")
    print(f"[{cid}] {platform}/{action}/{mode} a{attempt} {rec['elapsed_seconds']}s -> {rec['classification']} {brief(rec['response_body'])}",flush=True)
    return rec

def run_sync(cid,platform,action,path,payload):
    last=None
    for a in range(1,MAX_ATTEMPTS+1):
        last=post(cid,platform,action,path,payload,"sync",a)
        if last["classification"]=="success": break
        if last["classification"]=="auth_error": raise SystemExit("认证失败")
        if last["classification"] not in ("transport_error","rate_limited","server_error"): break
        if a<MAX_ATTEMPTS: time.sleep(2 if a==1 else 8)
    results[cid]=last; return last

def run_async(cid,platform,action,path,payload):
    global calls
    sub=post(cid,platform,action,path,payload,"async",1)
    body=sub["response_body"] if isinstance(sub["response_body"],dict) else {}
    data=body.get("data") if isinstance(body.get("data"),dict) else {}
    tid=data.get("task_id"); st=data.get("status")
    if st in ("succeeded","failed") or not tid:
        results[cid]=sub; return sub
    last=sub
    for i in range(1,MAX_POLLS+1):
        time.sleep(POLL_INTERVAL)
        if calls>=BUDGET: raise SystemExit("预算上限")
        calls+=1
        rec={"case":cid,"platform":platform,"action":"tasks.get","mode":"async-poll","endpoint":f"/openapi/v1/tasks/{tid}",
             "started_at":now(),"http_status":None,"response_body":None,"transport_error":None,"classification":None}
        status,raw,err=http("GET",f"{BASE_URL}/openapi/v1/tasks/{tid}",timeout=120)
        if err: rec["transport_error"]=err
        else:
            rec["http_status"]=status
            try: rec["response_body"]=json.loads(raw.decode())
            except Exception: rec["response_body"]={"_unparsable":raw.decode("utf-8","replace")[:2000]}
        rec["classification"]=classify(rec["http_status"],rec["response_body"],rec["transport_error"])
        save(rec,f"{cid}-{platform}-poll{i}.json")
        print(f"[{cid}] poll{i} -> {rec['classification']} {brief(rec['response_body'])}",flush=True)
        last=rec
        if rec["classification"] in ("success","provider_failed"): break
    results[cid]=last; return last

def cursor_of(cid):
    r=results.get(cid,{})
    data=(r.get("response_body") or {}).get("data") or {}
    res=data.get("result") or {}
    return res.get("max_cursor") if isinstance(res,dict) else None

INVALID_DY="5- 长按复制此条消息，打开抖音搜索，查看TA的更多作品。 https://v.douyin.com/Own0gt7Z-pM/ 8@1.com :8pm"
EMPTY_DY="0- 长按复制此条消息，打开抖音搜索，查看TA的更多作品。 https://v.douyin.com/sQi3uYr-Fvg/ 5@5.com :8pm"
DY_COMMENT_VIDEO="1.58 :6pm 09/06 D@H.ip FHI:/ 盛夏抗暑 # 日立硬核抗暑# 极速降温挑战# 三伏天续命神器# 日立硬核抗暑 # 一人一境舒爽一夏 # 日立中央空调品牌月# 日立中央空调  https://v.douyin.com/a3Y63kFd6cI/"
DY_PINNED="https://www.douyin.com/user/MS4wLjABAAAA8xzA5Dl7N--l2aBhBJ-cZd1VCTLrU6SitX9dTWbRmmU?from_tab_name=main&relation=0&vid=7688996630141924731"
XHS_VIDEO_NOTE="教男生快速抓自然的中式前刺 https://xhslink.cn/o/7JeAVeidWdW"
XHS_COMMENT_NOTE="如何21天做完一个竞赛（Evolo荣誉提名） 这是我和璐子... https://xhslink.cn/o/5ajIs8UBi74"
XHS_PINNED="@郭四火- 在小红书已经有20万个粉丝，点击链接或复制口令查看Ta的主页>> https://xhslink.cn/o/80LXppCuBYY"

# C01 失效链接
run_sync("C01","douyin","media_user_info","/openapi/v1/media_user_info",{"url":INVALID_DY})
# C02/C03 空账号
run_sync("C02","douyin","media_user_info","/openapi/v1/media_user_info",{"url":EMPTY_DY})
run_sync("C03","douyin","user_video_list","/openapi/v1/user_video_list",{"url":EMPTY_DY,"max_cursor":0})
# C04 小红书视频笔记详情
run_sync("C04","xiaohongshu","media_stats_number","/openapi/v1/media_stats_number",{"url":XHS_VIDEO_NOTE})
# C05/C06/C07 小红书评论分页与回复
run_sync("C05","xiaohongshu","post_comments_list","/openapi/v1/media/comments/list",{"url":XHS_COMMENT_NOTE,"max_cursor":0,"reply_pages":-1})
cur=cursor_of("C05")
run_sync("C06","xiaohongshu","post_comments_list","/openapi/v1/media/comments/list",{"url":XHS_COMMENT_NOTE,"max_cursor":cur,"reply_pages":-1})
run_sync("C07","xiaohongshu","post_comments_list","/openapi/v1/media/comments/list",{"url":XHS_COMMENT_NOTE,"max_cursor":0,"reply_pages":-2})
# C08/C09/C10 小红书置顶主页
run_sync("C08","xiaohongshu","media_user_info","/openapi/v1/media_user_info",{"url":XHS_PINNED})
run_sync("C09","xiaohongshu","user_video_list","/openapi/v1/user_video_list",{"url":XHS_PINNED,"max_cursor":0})
cur=cursor_of("C09")
run_sync("C10","xiaohongshu","user_video_list","/openapi/v1/user_video_list",{"url":XHS_PINNED,"max_cursor":cur})
# C11/C12/C13 抖音评论分页与回复
run_sync("C11","douyin","post_comments_list","/openapi/v1/media/comments/list",{"url":DY_COMMENT_VIDEO,"max_cursor":0,"reply_pages":-1})
cur=cursor_of("C11")
run_sync("C12","douyin","post_comments_list","/openapi/v1/media/comments/list",{"url":DY_COMMENT_VIDEO,"max_cursor":cur,"reply_pages":-1})
run_sync("C13","douyin","post_comments_list","/openapi/v1/media/comments/list",{"url":DY_COMMENT_VIDEO,"max_cursor":0,"reply_pages":-2})
# C14/C15/C16 抖音置顶主页
run_sync("C14","douyin","media_user_info","/openapi/v1/media_user_info",{"url":DY_PINNED})
run_sync("C15","douyin","user_video_list","/openapi/v1/user_video_list",{"url":DY_PINNED,"max_cursor":0})
cur=cursor_of("C15")
run_sync("C16","douyin","user_video_list","/openapi/v1/user_video_list",{"url":DY_PINNED,"max_cursor":cur})
# C17 抖音列表异步
run_async("C17","douyin","user_video_list","/openapi/v1/user_video_list",{"url":DY_PINNED,"max_cursor":0})
# C18 抖音评论异步
run_async("C18","douyin","post_comments_list","/openapi/v1/media/comments/list",{"url":DY_COMMENT_VIDEO,"max_cursor":0,"reply_pages":-1})
# C19 认证失败（错误 Key，不计点）
rec=post("C19","douyin","media_user_info","/openapi/v1/media_user_info",{"url":EMPTY_DY},"sync",1,key="invalid-test-key-raw7")
results["C19"]=rec

summary={"date":"2026-10-28","calls":calls,"results":{k:{"classification":v.get("classification"),"brief":brief(v.get("response_body"))} for k,v in results.items()}}
json.dump(summary,open(os.path.join(OUT_DIR,"SUMMARY.json"),"w",encoding="utf-8"),ensure_ascii=False,indent=2)
print(f"完成：调用 {calls} 次")

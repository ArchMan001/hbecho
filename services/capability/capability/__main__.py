"""`python -m capability`：单 worker 的 uvicorn。只绑定容器内网地址，端口不映射到宿主（compose 约束）。"""
import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run("capability.app:app", host=os.environ.get("CAPABILITY_HOST", "0.0.0.0"), port=int(os.environ.get("CAPABILITY_PORT", "8080")), workers=1, access_log=False)

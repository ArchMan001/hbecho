# FieldShortcut/A Master API 开发文档 V1.2 for 海信博世

本文档介绍 FieldShortcut 公开 API 中 12 个媒体数据相关接口的使用方法和参数说明。

**API 基础地址**：`https://openapi.fieldshortcut.com`

**认证方式**：Bearer Token

**文档生成时间**：2026-08-19 21:01:52

---

## 通用说明

### 认证方式

所有接口支持两种认证方式：

1. **Bearer Token**：在请求头中添加 `Authorization` 字段

   ```HTTP
   Authorization: Bearer your_token_here
   ```

### 请求方式

所有接口使用 `POST` 方法，请求体为 JSON 格式。

### 异步执行模式

所有接口支持异步执行：

- **异步执行（默认）**：`async=true`，接口立即返回任务 ID，需要通过任务查询接口获取结果
- **同步执行**：`async=false`，接口等待任务完成后返回结果（可能耗时较长）

### 任务状态

任务状态包括：

- `queued`：任务排队中
- `running`：任务执行中
- `succeeded`：任务执行成功
- `failed`：任务执行失败

### 响应结构

所有接口响应包含以下字段：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "任务ID",
    "action": "接口名称",
    "status": "任务状态",
    "result": { "任务结果数据" },
    "error": null,
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:05Z"
  },
  "request_id": "req_xxxxx"
}
```

### 任务查询

使用任务 ID 查询任务状态和结果：

```HTTP
GET /openapi/v1/tasks/{task_id}
```

---

## 1. 获取媒体用户信息

**接口路径**：`POST /openapi/v1/media_user_info`

**接口名称**：`media_user_info`

**功能描述**：运行捷径：media_user_info

---

### 请求参数

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `url` | string | 是 | - | url 参数 |

#### 请求示例

```Bash
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/media_user_info" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/media/sample"}'
```

---

### 响应说明

接口返回包含任务信息的 JSON 对象。

#### 提交响应（202 Accepted）

任务提交成功后立即返回：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_media_user_info_xxxxxx",
    "action": "media_user_info",
    "status": "running",
    "result": null,
    "error": null,
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 成功响应（200 OK）

任务完成后返回实际数据：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_media_user_info_xxxxxx",
    "action": "media_user_info",
    "status": "succeeded",
    "result": {
      "user_id": "7382910483920123456",
      "nickname": "示例用户昵称",
      "signature": "这是用户签名示例",
      "location": "IP属地：北京",
      "avatar": "https://example.com/avatar.jpg",
      "cover": "https://example.com/cover.jpg",
      "follower_count": 123456,
      "following_count": 789,
      "like_count": 987654,
      "post_count": 152,
      "updated": 1736948405
    },
    "error": null,
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:05Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 错误响应（4xx/5xx）

请求失败时返回错误信息：

```JSON
{
  "code": 400,
  "data": {
    "task_id": "task_error_xxxxx",
    "action": "media_user_info",
    "status": "failed",
    "result": null,
    "error": {
      "code": "INVALID_URL",
      "message": "提供的 URL 无效或无法访问"
    },
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_xyz789"
}
```

---

### 结果字段说明

任务成功后，`result` 字段包含以下数据：

| 字段名 | 类型 | 说明 |
|-|-|-|
| `user_id` | string | 字符串 |
| `nickname` | string | 字符串 |
| `signature` | string | 字符串 |
| `location` | string | 字符串 |
| `avatar` | string | 字符串 |
| `cover` | string | 字符串 |
| `follower_count` | integer | 整数 |
| `following_count` | integer | 整数 |
| `like_count` | integer | 整数 |
| `post_count` | integer | 整数 |
| `updated` | integer | 时间戳（秒） |

### 使用示例

#### 1. 提交任务

```Bash
# 异步执行（默认）
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/media_user_info?async=true" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/media/sample"}'
```

#### 2. 查询任务结果

```Bash
curl -X GET "https://openapi.fieldshortcut.com/openapi/v1/tasks/task_media_user_info_xxxxxx" \
  -H "X-Api-Key: your_api_key_here"
```

#### 3. 使用 Python 调用

```Python
import requests
import json

# 1. 提交任务
url = "https://openapi.fieldshortcut.com/openapi/v1/media_user_info"
headers = {"X-Api-Key": "your_api_key_here"}
data = {"url": "https://example.com/media/sample"}

response = requests.post(url, headers=headers, json=data)
task_data = response.json()

if task_data["code"] == 0:
    task_id = task_data["data"]["task_id"]
    print(f"任务已提交，ID: {task_id}")

    # 2. 查询任务结果
    result_url = "https://openapi.fieldshortcut.com/openapi/v1/tasks/{task_id}"
    result_response = requests.get(result_url, headers=headers)
    result_data = result_response.json()

    if result_data["data"]["status"] == "succeeded":
        result = result_data["data"]["result"]
        print(f"任务结果: {json.dumps(result, indent=2, ensure_ascii=False)}")
```

---


## 2. 获取媒体发布内容统计

**接口路径**：`POST /openapi/v1/media_stats_number`

**接口名称**：`media_stats_number`

**功能描述**：运行捷径：media_stats

---

### 请求参数

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `url` | string | 是 | - | url 参数 |

#### 请求示例

```Bash
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/media_stats_number" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/post/sample"}'
```

---

### 响应说明

接口返回包含任务信息的 JSON 对象。

#### 提交响应（202 Accepted）

任务提交成功后立即返回：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_media_stats_number_xxxxxx",
    "action": "media_stats_number",
    "status": "running",
    "result": null,
    "error": null,
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 成功响应（200 OK）

任务完成后返回实际数据：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_media_stats_number_xxxxxx",
    "action": "media_stats_number",
    "status": "succeeded",
    "result": {
      "author_name": "示例作者名称",
      "title": "示例视频标题，这里是视频的完整标题内容",
      "tag_text": "#标签1 #标签2 #标签3",
      "play_number": 123456,
      "like_number": 9876,
      "comment_number": 543,
      "collect_number": 321,
      "share_number": 210,
      "download_urls": "https://example.com/video.mp4",
      "cover": "https://example.com/cover.jpg",
      "duration_number": 120,
      "publish_location": "发布地点：北京",
      "post_id": "7382910483920123456",
      "platform": "douyin",
      "created": 1736862005,
      "updated": 1736948405
    },
    "error": null,
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:05Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 错误响应（4xx/5xx）

请求失败时返回错误信息：

```JSON
{
  "code": 400,
  "data": {
    "task_id": "task_error_xxxxx",
    "action": "media_stats_number",
    "status": "failed",
    "result": null,
    "error": {
      "code": "INVALID_URL",
      "message": "提供的 URL 无效或无法访问"
    },
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_xyz789"
}
```

---

### 结果字段说明

任务成功后，`result` 字段包含以下数据：

| 字段名 | 类型 | 说明 |
|-|-|-|
| `author_name` | string | 字符串 |
| `title` | string | 字符串 |
| `tag_text` | string | 字符串 |
| `play_number` | integer | 整数 |
| `like_number` | integer | 整数 |
| `comment_number` | integer | 整数 |
| `collect_number` | integer | 整数 |
| `share_number` | integer | 整数 |
| `download_urls` | string | 字符串 |
| `cover` | string | 字符串 |
| `duration_number` | integer | 整数 |
| `publish_location` | string | 字符串 |
| `post_id` | string | 字符串 |
| `platform` | string | 字符串 |
| `created` | integer | 时间戳（秒） |
| `updated` | integer | 时间戳（秒） |

### 使用示例

#### 1. 提交任务

```Bash
# 异步执行（默认）
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/media_stats_number?async=true" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/post/sample"}'
```

#### 2. 查询任务结果

```Bash
curl -X GET "https://openapi.fieldshortcut.com/openapi/v1/tasks/task_media_stats_number_xxxxxx" \
  -H "X-Api-Key: your_api_key_here"
```

#### 3. 使用 Python 调用

```Python
import requests
import json

# 1. 提交任务
url = "https://openapi.fieldshortcut.com/openapi/v1/media_stats_number"
headers = {"X-Api-Key": "your_api_key_here"}
data = {"url": "https://example.com/post/sample"}

response = requests.post(url, headers=headers, json=data)
task_data = response.json()

if task_data["code"] == 0:
    task_id = task_data["data"]["task_id"]
    print(f"任务已提交，ID: {task_id}")

    # 2. 查询任务结果
    result_url = "https://openapi.fieldshortcut.com/openapi/v1/tasks/{task_id}"
    result_response = requests.get(result_url, headers=headers)
    result_data = result_response.json()

    if result_data["data"]["status"] == "succeeded":
        result = result_data["data"]["result"]
        print(f"任务结果: {json.dumps(result, indent=2, ensure_ascii=False)}")
```

---


## 3. 获取媒体互动统计

**接口路径**：`POST /openapi/v1/media_stats`

**接口名称**：`media_stats`

**功能描述**：运行捷径：media_stats

---

### 请求参数

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `url` | string | 是 | - | url 参数 |

#### 请求示例

```Bash
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/media_stats" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/post/sample"}'
```

---

### 响应说明

接口返回包含任务信息的 JSON 对象。

#### 提交响应（202 Accepted）

任务提交成功后立即返回：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_media_stats_xxxxxx",
    "action": "media_stats",
    "status": "running",
    "result": null,
    "error": null,
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 成功响应（200 OK）

任务完成后返回实际数据：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_media_stats_xxxxxx",
    "action": "media_stats",
    "status": "succeeded",
    "result": {
      "author_name": "示例作者名称",
      "post_id": "7382910483920123456",
      "title": "示例视频标题，这里是视频的完整标题内容",
      "tag_text": "#标签1 #标签2 #标签3",
      "play_count": 123456,
      "like_count": 9876,
      "comment_count": 543,
      "collect_count": 321,
      "share_count": 210,
      "download_urls": "https://example.com/video.mp4,https://example.com/backup.mp4",
      "cover": "https://example.com/cover.jpg",
      "duration": 120,
      "publish_location": "发布地点：北京",
      "platform": "douyin",
      "created": 1736862005,
      "updated": 1736948405
    },
    "error": null,
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:05Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 错误响应（4xx/5xx）

请求失败时返回错误信息：

```JSON
{
  "code": 400,
  "data": {
    "task_id": "task_error_xxxxx",
    "action": "media_stats",
    "status": "failed",
    "result": null,
    "error": {
      "code": "INVALID_URL",
      "message": "提供的 URL 无效或无法访问"
    },
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_xyz789"
}
```

---

### 结果字段说明

任务成功后，`result` 字段包含以下数据：

| 字段名 | 类型 | 说明 |
|-|-|-|
| `author_name` | string | 字符串 |
| `post_id` | string | 字符串 |
| `title` | string | 字符串 |
| `tag_text` | string | 字符串 |
| `play_count` | integer | 整数 |
| `like_count` | integer | 整数 |
| `comment_count` | integer | 整数 |
| `collect_count` | integer | 整数 |
| `share_count` | integer | 整数 |
| `download_urls` | string | 字符串 |
| `cover` | string | 字符串 |
| `duration` | integer | 整数 |
| `publish_location` | string | 字符串 |
| `platform` | string | 字符串 |
| `created` | integer | 时间戳（秒） |
| `updated` | integer | 时间戳（秒） |

### 使用示例

#### 1. 提交任务

```Bash
# 异步执行（默认）
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/media_stats?async=true" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/post/sample"}'
```

#### 2. 查询任务结果

```Bash
curl -X GET "https://openapi.fieldshortcut.com/openapi/v1/tasks/task_media_stats_xxxxxx" \
  -H "X-Api-Key: your_api_key_here"
```

#### 3. 使用 Python 调用

```Python
import requests
import json

# 1. 提交任务
url = "https://openapi.fieldshortcut.com/openapi/v1/media_stats"
headers = {"X-Api-Key": "your_api_key_here"}
data = {"url": "https://example.com/post/sample"}

response = requests.post(url, headers=headers, json=data)
task_data = response.json()

if task_data["code"] == 0:
    task_id = task_data["data"]["task_id"]
    print(f"任务已提交，ID: {task_id}")

    # 2. 查询任务结果
    result_url = "https://openapi.fieldshortcut.com/openapi/v1/tasks/{task_id}"
    result_response = requests.get(result_url, headers=headers)
    result_data = result_response.json()

    if result_data["data"]["status"] == "succeeded":
        result = result_data["data"]["result"]
        print(f"任务结果: {json.dumps(result, indent=2, ensure_ascii=False)}")
```

---


## 4. 获取用户视频列表

**接口路径**：`POST /openapi/v1/user_video_list`

**接口名称**：`user_video_list`

**功能描述**：运行捷径：user_video_list

---

### 请求参数

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `url` | string | 是 | - | url 参数 |
| `max_cursor` | integer/string | 否 | 0 | 翻页游标，首次请求传 0 或不传，翻页时使用上次响应返回的 cursor |

#### 请求示例

```Bash
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/user_video_list" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/media/sample"}'
```

---

### 响应说明

接口返回包含任务信息的 JSON 对象。

#### 提交响应（202 Accepted）

任务提交成功后立即返回：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_user_video_list_xxxxxx",
    "action": "user_video_list",
    "status": "running",
    "result": null,
    "error": null,
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 成功响应（200 OK）

任务完成后返回实际数据：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_user_video_list_xxxxxx",
    "action": "user_video_list",
    "status": "succeeded",
    "result": {
      "result": [
        {
          "video_id": "7382910483920123456",
          "title": "示例视频标题",
          "share_url": "https://example.com/video/sample",
          "cover": "https://example.com/media/cover.jpg",
          "play_count": 123456,
          "like_count": 9876,
          "comment_count": 543,
          "created": 1736862005,
          "duration": 120
        },
        {
          "video_id": "7382910483920123457",
          "title": "示例视频标题2",
          "share_url": "https://example.com/video/sample2",
          "cover": "https://example.com/media/cover2.jpg",
          "play_count": 789012,
          "like_count": 5432,
          "comment_count": 321,
          "created": 1736775605,
          "duration": 90
        }
      ],
      "has_more": true,
      "cursor": "MTc3NjgwMTIzNDV8fHwxNzg2NTQzMjEwfHx8fHw="
    },
    "error": null,
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:05Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 错误响应（4xx/5xx）

请求失败时返回错误信息：

```JSON
{
  "code": 400,
  "data": {
    "task_id": "task_error_xxxxx",
    "action": "user_video_list",
    "status": "failed",
    "result": null,
    "error": {
      "code": "INVALID_URL",
      "message": "提供的 URL 无效或无法访问"
    },
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_xyz789"
}
```

---

### 结果字段说明

任务成功后，`result` 字段包含以下数据：

| 字段名 | 类型 | 说明 |
|-|-|-|
| `result` | array | 包含对象数组，详细结构见下方说明 |
| `has_more` | boolean | 布尔类型 |
| `cursor` | string | 字符串 |

### 使用示例

#### 1. 提交任务

```Bash
# 异步执行（默认）
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/user_video_list?async=true" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/media/sample"}'
```

#### 2. 查询任务结果

```Bash
curl -X GET "https://openapi.fieldshortcut.com/openapi/v1/tasks/task_user_video_list_xxxxxx" \
  -H "X-Api-Key: your_api_key_here"
```

#### 3. 使用 Python 调用

```Python
import requests
import json

# 1. 提交任务
url = "https://openapi.fieldshortcut.com/openapi/v1/user_video_list"
headers = {"X-Api-Key": "your_api_key_here"}
data = {"url": "https://example.com/media/sample"}

response = requests.post(url, headers=headers, json=data)
task_data = response.json()

if task_data["code"] == 0:
    task_id = task_data["data"]["task_id"]
    print(f"任务已提交，ID: {task_id}")

    # 2. 查询任务结果
    result_url = "https://openapi.fieldshortcut.com/openapi/v1/tasks/{task_id}"
    result_response = requests.get(result_url, headers=headers)
    result_data = result_response.json()

    if result_data["data"]["status"] == "succeeded":
        result = result_data["data"]["result"]
        print(f"任务结果: {json.dumps(result, indent=2, ensure_ascii=False)}")
```

---


## 5. 获取用户合集列表

**接口路径**：`POST /openapi/v1/user_series_list`

**接口名称**：`user_series_list`

**功能描述**：运行捷径：user_series_list

---

### 请求参数

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `url` | string | 是 | - | url 参数 |
| `max_cursor` | integer/string | 否 | 0 | 翻页游标，首次请求传 0 或不传，翻页时使用上次响应返回的 cursor |

#### 请求示例

```Bash
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/user_series_list" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/media/sample"}'
```

---

### 响应说明

接口返回包含任务信息的 JSON 对象。

#### 提交响应（202 Accepted）

任务提交成功后立即返回：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_user_series_list_xxxxxx",
    "action": "user_series_list",
    "status": "running",
    "result": null,
    "error": null,
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 成功响应（200 OK）

任务完成后返回实际数据：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_user_series_list_xxxxxx",
    "action": "user_series_list",
    "status": "succeeded",
    "result": {
      "result": [
        {
          "series_id": "7382910483920123456",
          "title": "示例合集标题",
          "cover": "https://example.com/series/cover.jpg",
          "video_count": 15,
          "play_count": 1234567,
          "created": 1736862005
        }
      ],
      "has_more": false,
      "cursor": ""
    },
    "error": null,
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:05Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 错误响应（4xx/5xx）

请求失败时返回错误信息：

```JSON
{
  "code": 400,
  "data": {
    "task_id": "task_error_xxxxx",
    "action": "user_series_list",
    "status": "failed",
    "result": null,
    "error": {
      "code": "INVALID_URL",
      "message": "提供的 URL 无效或无法访问"
    },
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_xyz789"
}
```

---

### 结果字段说明

任务成功后，`result` 字段包含以下数据：

| 字段名 | 类型 | 说明 |
|-|-|-|
| `result` | array | 包含对象数组，详细结构见下方说明 |
| `has_more` | boolean | 布尔类型 |
| `cursor` | string | 字符串 |

### 使用示例

#### 1. 提交任务

```Bash
# 异步执行（默认）
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/user_series_list?async=true" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/media/sample"}'
```

#### 2. 查询任务结果

```Bash
curl -X GET "https://openapi.fieldshortcut.com/openapi/v1/tasks/task_user_series_list_xxxxxx" \
  -H "X-Api-Key: your_api_key_here"
```

#### 3. 使用 Python 调用

```Python
import requests
import json

# 1. 提交任务
url = "https://openapi.fieldshortcut.com/openapi/v1/user_series_list"
headers = {"X-Api-Key": "your_api_key_here"}
data = {"url": "https://example.com/media/sample"}

response = requests.post(url, headers=headers, json=data)
task_data = response.json()

if task_data["code"] == 0:
    task_id = task_data["data"]["task_id"]
    print(f"任务已提交，ID: {task_id}")

    # 2. 查询任务结果
    result_url = "https://openapi.fieldshortcut.com/openapi/v1/tasks/{task_id}"
    result_response = requests.get(result_url, headers=headers)
    result_data = result_response.json()

    if result_data["data"]["status"] == "succeeded":
        result = result_data["data"]["result"]
        print(f"任务结果: {json.dumps(result, indent=2, ensure_ascii=False)}")
```

---


## 6. 获取用户最新视频

**接口路径**：`POST /openapi/v1/user_latest_video`

**接口名称**：`user_latest_video`

**功能描述**：运行捷径：user_latest_video

---

### 请求参数

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `url` | string | 是 | - | url 参数 |

#### 请求示例

```Bash
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/user_latest_video" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/media/sample"}'
```

---

### 响应说明

接口返回包含任务信息的 JSON 对象。

#### 提交响应（202 Accepted）

任务提交成功后立即返回：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_user_latest_video_xxxxxx",
    "action": "user_latest_video",
    "status": "running",
    "result": null,
    "error": null,
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 成功响应（200 OK）

任务完成后返回实际数据：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_user_latest_video_xxxxxx",
    "action": "user_latest_video",
    "status": "succeeded",
    "result": {
      "video_id": "7382910483920123456",
      "author_name": "示例作者名称",
      "title": "最新视频标题示例",
      "tag_text": "#最新 #热门",
      "play_count": 123456,
      "like_count": 9876,
      "comment_count": 543,
      "collect_count": 321,
      "share_count": 210,
      "download_urls": "https://example.com/latest.mp4",
      "cover": "https://example.com/latest_cover.jpg",
      "duration": 120,
      "share_url": "https://example.com/latest",
      "created": 1736862005,
      "updated": 1736948405
    },
    "error": null,
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:05Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 错误响应（4xx/5xx）

请求失败时返回错误信息：

```JSON
{
  "code": 400,
  "data": {
    "task_id": "task_error_xxxxx",
    "action": "user_latest_video",
    "status": "failed",
    "result": null,
    "error": {
      "code": "INVALID_URL",
      "message": "提供的 URL 无效或无法访问"
    },
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_xyz789"
}
```

---

### 结果字段说明

任务成功后，`result` 字段包含以下数据：

| 字段名 | 类型 | 说明 |
|-|-|-|
| `video_id` | string | 字符串 |
| `author_name` | string | 字符串 |
| `title` | string | 字符串 |
| `tag_text` | string | 字符串 |
| `play_count` | integer | 整数 |
| `like_count` | integer | 整数 |
| `comment_count` | integer | 整数 |
| `collect_count` | integer | 整数 |
| `share_count` | integer | 整数 |
| `download_urls` | string | 字符串 |
| `cover` | string | 字符串 |
| `duration` | integer | 整数 |
| `share_url` | string | 字符串 |
| `created` | integer | 时间戳（秒） |
| `updated` | integer | 时间戳（秒） |

### 使用示例

#### 1. 提交任务

```Bash
# 异步执行（默认）
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/user_latest_video?async=true" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/media/sample"}'
```

#### 2. 查询任务结果

```Bash
curl -X GET "https://openapi.fieldshortcut.com/openapi/v1/tasks/task_user_latest_video_xxxxxx" \
  -H "X-Api-Key: your_api_key_here"
```

#### 3. 使用 Python 调用

```Python
import requests
import json

# 1. 提交任务
url = "https://openapi.fieldshortcut.com/openapi/v1/user_latest_video"
headers = {"X-Api-Key": "your_api_key_here"}
data = {"url": "https://example.com/media/sample"}

response = requests.post(url, headers=headers, json=data)
task_data = response.json()

if task_data["code"] == 0:
    task_id = task_data["data"]["task_id"]
    print(f"任务已提交，ID: {task_id}")

    # 2. 查询任务结果
    result_url = "https://openapi.fieldshortcut.com/openapi/v1/tasks/{task_id}"
    result_response = requests.get(result_url, headers=headers)
    result_data = result_response.json()

    if result_data["data"]["status"] == "succeeded":
        result = result_data["data"]["result"]
        print(f"任务结果: {json.dumps(result, indent=2, ensure_ascii=False)}")
```

---


## 7. 获取作品评论列表

**接口路径**：`POST /openapi/v1/media/comments/list`

**接口名称**：`post_comments_list`

**功能描述**：运行捷径：post_comments_list

---

### 请求参数

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `url` | string | 是 | - | url 参数 |
| `max_cursor` | integer/string | 否 | 0 | 翻页游标，首次请求传 0 或不传，翻页时使用上次响应返回的 cursor |
| `reply_pages` | integer | 否 | -1 | 评论回复页数：-1=不获取回复，-2=获取全部回复，N=获取前 N 页（每页 20 条） |

#### 请求示例

```Bash
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/media/comments/list" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/media/sample"}'
```

---

### 响应说明

接口返回包含任务信息的 JSON 对象。

#### 提交响应（202 Accepted）

任务提交成功后立即返回：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_post_comments_list_xxxxxx",
    "action": "post_comments_list",
    "status": "running",
    "result": null,
    "error": null,
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 成功响应（200 OK）

任务完成后返回实际数据：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_post_comments_list_xxxxxx",
    "action": "post_comments_list",
    "status": "succeeded",
    "result": {
      "result": [
        {
          "comment_id": "7382910483920123456",
          "content": "这是一条示例评论内容，表达了对视频的赞赏和观点",
          "author_name": "评论用户A",
          "author_avatar": "https://example.com/avatar1.jpg",
          "like_count": 100,
          "reply_count": 5,
          "created": 1736944805
        },
        {
          "comment_id": "7382910483920123457",
          "content": "另一条示例评论内容，讨论了视频的话题",
          "author_name": "评论用户B",
          "author_avatar": "https://example.com/avatar2.jpg",
          "like_count": 50,
          "reply_count": 2,
          "created": 1736941205
        }
      ],
      "cursor": "MTc3NjgwMTIzNDV8fHwxNzg2NTQzMjEwfHx8fHw=",
      "reply_page_count": 3
    },
    "error": null,
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:05Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 错误响应（4xx/5xx）

请求失败时返回错误信息：

```JSON
{
  "code": 400,
  "data": {
    "task_id": "task_error_xxxxx",
    "action": "post_comments_list",
    "status": "failed",
    "result": null,
    "error": {
      "code": "INVALID_URL",
      "message": "提供的 URL 无效或无法访问"
    },
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_xyz789"
}
```

---

### 结果字段说明

任务成功后，`result` 字段包含以下数据：

| 字段名 | 类型 | 说明 |
|-|-|-|
| `result` | array | 包含对象数组，详细结构见下方说明 |
| `cursor` | string | 字符串 |
| `reply_page_count` | integer | 整数 |

### 使用示例

#### 1. 提交任务

```Bash
# 异步执行（默认）
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/media/comments/list?async=true" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/media/sample"}'
```

#### 2. 查询任务结果

```Bash
curl -X GET "https://openapi.fieldshortcut.com/openapi/v1/tasks/task_post_comments_list_xxxxxx" \
  -H "X-Api-Key: your_api_key_here"
```

#### 3. 使用 Python 调用

```Python
import requests
import json

# 1. 提交任务
url = "https://openapi.fieldshortcut.com/openapi/v1/media/comments/list"
headers = {"X-Api-Key": "your_api_key_here"}
data = {"url": "https://example.com/media/sample"}

response = requests.post(url, headers=headers, json=data)
task_data = response.json()

if task_data["code"] == 0:
    task_id = task_data["data"]["task_id"]
    print(f"任务已提交，ID: {task_id}")

    # 2. 查询任务结果
    result_url = "https://openapi.fieldshortcut.com/openapi/v1/tasks/{task_id}"
    result_response = requests.get(result_url, headers=headers)
    result_data = result_response.json()

    if result_data["data"]["status"] == "succeeded":
        result = result_data["data"]["result"]
        print(f"任务结果: {json.dumps(result, indent=2, ensure_ascii=False)}")
```

---


## 8. 获取媒体评论摘要

**接口路径**：`POST /openapi/v1/media/comments`

**接口名称**：`media_comments`

**功能描述**：运行捷径：media_comments

---

### 请求参数

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `url` | string | 是 | - | url 参数 |
| `max_cursor` | integer/string | 否 | 0 | 翻页游标，首次请求传 0 或不传，翻页时使用上次响应返回的 cursor |
| `count` | integer | 否 | 20 | 每页评论数量（1-200） |
| `pages` | integer | 否 | 1 | 获取页数（1-10），用于一次性获取多页评论 |

#### 请求示例

```Bash
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/media/comments" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/post/sample"}'
```

---

### 响应说明

接口返回包含任务信息的 JSON 对象。

#### 提交响应（202 Accepted）

任务提交成功后立即返回：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_media_comments_xxxxxx",
    "action": "media_comments",
    "status": "running",
    "result": null,
    "error": null,
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 成功响应（200 OK）

任务完成后返回实际数据：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_media_comments_xxxxxx",
    "action": "media_comments",
    "status": "succeeded",
    "result": {
      "post_id": "7382910483920123456",
      "comments_str": "评论1：这是示例评论内容\\n评论2：这是第二条示例评论\\n评论3：这是第三条示例评论内容，展示更多文本",
      "cursor": "MTc3NjgwMTIzNDV8fHwxNzg2NTQzMjEwfHx8fHw=",
      "updated": 1736948405
    },
    "error": null,
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:05Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 错误响应（4xx/5xx）

请求失败时返回错误信息：

```JSON
{
  "code": 400,
  "data": {
    "task_id": "task_error_xxxxx",
    "action": "media_comments",
    "status": "failed",
    "result": null,
    "error": {
      "code": "INVALID_URL",
      "message": "提供的 URL 无效或无法访问"
    },
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_xyz789"
}
```

---

### 结果字段说明

任务成功后，`result` 字段包含以下数据：

| 字段名 | 类型 | 说明 |
|-|-|-|
| `post_id` | string | 字符串 |
| `comments_str` | string | 字符串 |
| `cursor` | string | 字符串 |
| `updated` | integer | 时间戳（秒） |

### 使用示例

#### 1. 提交任务

```Bash
# 异步执行（默认）
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/media/comments?async=true" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/post/sample"}'
```

#### 2. 查询任务结果

```Bash
curl -X GET "https://openapi.fieldshortcut.com/openapi/v1/tasks/task_media_comments_xxxxxx" \
  -H "X-Api-Key: your_api_key_here"
```

#### 3. 使用 Python 调用

```Python
import requests
import json

# 1. 提交任务
url = "https://openapi.fieldshortcut.com/openapi/v1/media/comments"
headers = {"X-Api-Key": "your_api_key_here"}
data = {"url": "https://example.com/post/sample"}

response = requests.post(url, headers=headers, json=data)
task_data = response.json()

if task_data["code"] == 0:
    task_id = task_data["data"]["task_id"]
    print(f"任务已提交，ID: {task_id}")

    # 2. 查询任务结果
    result_url = "https://openapi.fieldshortcut.com/openapi/v1/tasks/{task_id}"
    result_response = requests.get(result_url, headers=headers)
    result_data = result_response.json()

    if result_data["data"]["status"] == "succeeded":
        result = result_data["data"]["result"]
        print(f"任务结果: {json.dumps(result, indent=2, ensure_ascii=False)}")
```

---


## 9. 获取媒体热门评论

**接口路径**：`POST /openapi/v1/media/hot_comments`

**接口名称**：`media_hot_comments`

**功能描述**：运行捷径：media_hot_comments

---

### 请求参数

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `url` | string | 是 | - | url 参数 |

#### 请求示例

```Bash
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/media/hot_comments" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/media/sample"}'
```

---

### 响应说明

接口返回包含任务信息的 JSON 对象。

#### 提交响应（202 Accepted）

任务提交成功后立即返回：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_media_hot_comments_xxxxxx",
    "action": "media_hot_comments",
    "status": "running",
    "result": null,
    "error": null,
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 成功响应（200 OK）

任务完成后返回实际数据：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_media_hot_comments_xxxxxx",
    "action": "media_hot_comments",
    "status": "succeeded",
    "result": {
      "user_id": "7382910483920123456",
      "kol_id": "7382910483920123456",
      "author_name": "示例用户名称",
      "total": 50,
      "hot_comments_str": "热门评论1：这是热门评论内容\\n热门评论2：这是第二条热门评论\\n热门评论3：这是第三条热门评论",
      "updated": 1736948405
    },
    "error": null,
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:05Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 错误响应（4xx/5xx）

请求失败时返回错误信息：

```JSON
{
  "code": 400,
  "data": {
    "task_id": "task_error_xxxxx",
    "action": "media_hot_comments",
    "status": "failed",
    "result": null,
    "error": {
      "code": "INVALID_URL",
      "message": "提供的 URL 无效或无法访问"
    },
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_xyz789"
}
```

---

### 结果字段说明

任务成功后，`result` 字段包含以下数据：

| 字段名 | 类型 | 说明 |
|-|-|-|
| `user_id` | string | 字符串 |
| `kol_id` | string | 字符串 |
| `author_name` | string | 字符串 |
| `total` | integer | 整数 |
| `hot_comments_str` | string | 字符串 |
| `updated` | integer | 时间戳（秒） |

### 使用示例

#### 1. 提交任务

```Bash
# 异步执行（默认）
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/media/hot_comments?async=true" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/media/sample"}'
```

#### 2. 查询任务结果

```Bash
curl -X GET "https://openapi.fieldshortcut.com/openapi/v1/tasks/task_media_hot_comments_xxxxxx" \
  -H "X-Api-Key: your_api_key_here"
```

#### 3. 使用 Python 调用

```Python
import requests
import json

# 1. 提交任务
url = "https://openapi.fieldshortcut.com/openapi/v1/media/hot_comments"
headers = {"X-Api-Key": "your_api_key_here"}
data = {"url": "https://example.com/media/sample"}

response = requests.post(url, headers=headers, json=data)
task_data = response.json()

if task_data["code"] == 0:
    task_id = task_data["data"]["task_id"]
    print(f"任务已提交，ID: {task_id}")

    # 2. 查询任务结果
    result_url = "https://openapi.fieldshortcut.com/openapi/v1/tasks/{task_id}"
    result_response = requests.get(result_url, headers=headers)
    result_data = result_response.json()

    if result_data["data"]["status"] == "succeeded":
        result = result_data["data"]["result"]
        print(f"任务结果: {json.dumps(result, indent=2, ensure_ascii=False)}")
```

---


## 10. 获取媒体热词榜

**接口路径**：`POST /openapi/v1/media_billboard`

**接口名称**：`media_billboard`

**功能描述**：运行捷径：media_billboard

---

### 请求参数

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `type` | string | 是 | - | type 参数 |

#### 请求示例

```Bash
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/media_billboard" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"type": "hot_video"}'
```

---

### 响应说明

接口返回包含任务信息的 JSON 对象。

#### 提交响应（202 Accepted）

任务提交成功后立即返回：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_media_billboard_xxxxxx",
    "action": "media_billboard",
    "status": "running",
    "result": null,
    "error": null,
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 成功响应（200 OK）

任务完成后返回实际数据：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_media_billboard_xxxxxx",
    "action": "media_billboard",
    "status": "succeeded",
    "result": {
      "type": "hot_video",
      "list_str": "1. 示例热榜内容1\\n2. 示例热榜内容2\\n3. 示例热榜内容3\\n4. 示例热榜内容4\\n5. 示例热榜内容5",
      "updated": 1736948405
    },
    "error": null,
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:05Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 错误响应（4xx/5xx）

请求失败时返回错误信息：

```JSON
{
  "code": 400,
  "data": {
    "task_id": "task_error_xxxxx",
    "action": "media_billboard",
    "status": "failed",
    "result": null,
    "error": {
      "code": "INVALID_URL",
      "message": "提供的 URL 无效或无法访问"
    },
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_xyz789"
}
```

---

### 结果字段说明

任务成功后，`result` 字段包含以下数据：

| 字段名 | 类型 | 说明 |
|-|-|-|
| `type` | string | 字符串 |
| `list_str` | string | 字符串 |
| `updated` | integer | 时间戳（秒） |

### 使用示例

#### 1. 提交任务

```Bash
# 异步执行（默认）
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/media_billboard?async=true" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"type": "hot_video"}'
```

#### 2. 查询任务结果

```Bash
curl -X GET "https://openapi.fieldshortcut.com/openapi/v1/tasks/task_media_billboard_xxxxxx" \
  -H "X-Api-Key: your_api_key_here"
```

#### 3. 使用 Python 调用

```Python
import requests
import json

# 1. 提交任务
url = "https://openapi.fieldshortcut.com/openapi/v1/media_billboard"
headers = {"X-Api-Key": "your_api_key_here"}
data = {"type": "hot_video"}

response = requests.post(url, headers=headers, json=data)
task_data = response.json()

if task_data["code"] == 0:
    task_id = task_data["data"]["task_id"]
    print(f"任务已提交，ID: {task_id}")

    # 2. 查询任务结果
    result_url = "https://openapi.fieldshortcut.com/openapi/v1/tasks/{task_id}"
    result_response = requests.get(result_url, headers=headers)
    result_data = result_response.json()

    if result_data["data"]["status"] == "succeeded":
        result = result_data["data"]["result"]
        print(f"任务结果: {json.dumps(result, indent=2, ensure_ascii=False)}")
```

---


## 11. 获取媒体榜单插件

**接口路径**：`POST /openapi/v1/media_billboard/plugin`

**接口名称**：`media_billboard_plugin`

**功能描述**：运行捷径：media_billboard_plugin

---

### 请求参数

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `url` | string | 是 | - | url 参数 |

#### 请求示例

```Bash
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/media_billboard/plugin" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/media/sample"}'
```

---

### 响应说明

接口返回包含任务信息的 JSON 对象。

#### 提交响应（202 Accepted）

任务提交成功后立即返回：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_media_billboard_plugin_xxxxxx",
    "action": "media_billboard_plugin",
    "status": "running",
    "result": null,
    "error": null,
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 成功响应（200 OK）

任务完成后返回实际数据：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_media_billboard_plugin_xxxxxx",
    "action": "media_billboard_plugin",
    "status": "succeeded",
    "result": {
      "result": [
        {
          "rank": 1,
          "title": "热榜标题1",
          "author": "示例作者1",
          "hot_value": 1234567,
          "cover": "https://example.com/hot1.jpg",
          "url": "https://example.com/hot1"
        },
        {
          "rank": 2,
          "title": "热榜标题2",
          "author": "示例作者2",
          "hot_value": 987654,
          "cover": "https://example.com/hot2.jpg",
          "url": "https://example.com/hot2"
        }
      ]
    },
    "error": null,
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:05Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 错误响应（4xx/5xx）

请求失败时返回错误信息：

```JSON
{
  "code": 400,
  "data": {
    "task_id": "task_error_xxxxx",
    "action": "media_billboard_plugin",
    "status": "failed",
    "result": null,
    "error": {
      "code": "INVALID_URL",
      "message": "提供的 URL 无效或无法访问"
    },
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_xyz789"
}
```

---

### 结果字段说明

任务成功后，`result` 字段包含以下数据：

| 字段名 | 类型 | 说明 |
|-|-|-|
| `result` | array | 包含对象数组，详细结构见下方说明 |

### 使用示例

#### 1. 提交任务

```Bash
# 异步执行（默认）
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/media_billboard/plugin?async=true" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/media/sample"}'
```

#### 2. 查询任务结果

```Bash
curl -X GET "https://openapi.fieldshortcut.com/openapi/v1/tasks/task_media_billboard_plugin_xxxxxx" \
  -H "X-Api-Key: your_api_key_here"
```

#### 3. 使用 Python 调用

```Python
import requests
import json

# 1. 提交任务
url = "https://openapi.fieldshortcut.com/openapi/v1/media_billboard/plugin"
headers = {"X-Api-Key": "your_api_key_here"}
data = {"url": "https://example.com/media/sample"}

response = requests.post(url, headers=headers, json=data)
task_data = response.json()

if task_data["code"] == 0:
    task_id = task_data["data"]["task_id"]
    print(f"任务已提交，ID: {task_id}")

    # 2. 查询任务结果
    result_url = "https://openapi.fieldshortcut.com/openapi/v1/tasks/{task_id}"
    result_response = requests.get(result_url, headers=headers)
    result_data = result_response.json()

    if result_data["data"]["status"] == "succeeded":
        result = result_data["data"]["result"]
        print(f"任务结果: {json.dumps(result, indent=2, ensure_ascii=False)}")
```

---


## 12. 获取媒体内容分析

**接口路径**：`POST /openapi/v1/media_analysis`

**接口名称**：`media_analysis`

**功能描述**：运行捷径：media_analysis

---

### 请求参数

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|-|-|-|-|-|
| `url` | string | 是 | - | url 参数 |

#### 请求示例

```Bash
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/media_analysis" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/media/sample"}'
```

---

### 响应说明

接口返回包含任务信息的 JSON 对象。

#### 提交响应（202 Accepted）

任务提交成功后立即返回：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_media_analysis_xxxxxx",
    "action": "media_analysis",
    "status": "running",
    "result": null,
    "error": null,
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 成功响应（200 OK）

任务完成后返回实际数据：

```JSON
{
  "code": 0,
  "data": {
    "task_id": "task_media_analysis_xxxxxx",
    "action": "media_analysis",
    "status": "succeeded",
    "result": {
      "summary": "这是视频内容的智能分析摘要，包含了视频的主要内容、亮点和关键信息。分析显示该视频属于娱乐类型，内容丰富有趣。",
      "subtitle": "这是视频的字幕文本内容，包含了视频中所有的对话和旁白文字信息。这些字幕可以用于进一步的内容分析和理解。",
      "truncated": false
    },
    "error": null,
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:05Z"
  },
  "request_id": "req_20240115103000_abc123"
}
```

#### 错误响应（4xx/5xx）

请求失败时返回错误信息：

```JSON
{
  "code": 400,
  "data": {
    "task_id": "task_error_xxxxx",
    "action": "media_analysis",
    "status": "failed",
    "result": null,
    "error": {
      "code": "INVALID_URL",
      "message": "提供的 URL 无效或无法访问"
    },
    "created_at": "2024-01-15T10:30:00Z"
  },
  "request_id": "req_20240115103000_xyz789"
}
```

---

### 结果字段说明

任务成功后，`result` 字段包含以下数据：

| 字段名 | 类型 | 说明 |
|-|-|-|
| `summary` | string | 字符串 |
| `subtitle` | string | 字符串 |
| `truncated` | boolean | 布尔类型 |

### 使用示例

#### 1. 提交任务

```Bash
# 异步执行（默认）
curl -X POST "https://openapi.fieldshortcut.com/openapi/v1/media_analysis?async=true" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{"url": "https://example.com/media/sample"}'
```

#### 2. 查询任务结果

```Bash
curl -X GET "https://openapi.fieldshortcut.com/openapi/v1/tasks/task_media_analysis_xxxxxx" \
  -H "X-Api-Key: your_api_key_here"
```

#### 3. 使用 Python 调用

```Python
import requests
import json

# 1. 提交任务
url = "https://openapi.fieldshortcut.com/openapi/v1/media_analysis"
headers = {"X-Api-Key": "your_api_key_here"}
data = {"url": "https://example.com/media/sample"}

response = requests.post(url, headers=headers, json=data)
task_data = response.json()

if task_data["code"] == 0:
    task_id = task_data["data"]["task_id"]
    print(f"任务已提交，ID: {task_id}")

    # 2. 查询任务结果
    result_url = "https://openapi.fieldshortcut.com/openapi/v1/tasks/{task_id}"
    result_response = requests.get(result_url, headers=headers)
    result_data = result_response.json()

    if result_data["data"]["status"] == "succeeded":
        result = result_data["data"]["result"]
        print(f"任务结果: {json.dumps(result, indent=2, ensure_ascii=False)}")
```

---

---

## 附录：项目实测更正（2026-10-28）

> **这一段不是供应商原文**，是 hbecho 项目实际调用后补充的观察记录。
> **失败可能是暂时现象**，不代表供应商的长期合同；以实测日期为准。
> 证据：`aimaster接口文档/测试结果/raw3/`、`raw4-2026-10-28/`、`raw5-2026-10-28/`、`raw6-2026-10-28/`；汇总见 `AI Master 能力与计费清单.xlsx`。

| # | 位置 | 原文/现状 | 实测观察 | 证据 |
|---:|---|---|---|---|
| 1 | 通用说明 · 认证方式 | 只列了 `Authorization: Bearer` | **`X-Api-Key` 可用**（本文示例本身也使用 `X-Api-Key`）；项目使用该方式 | C01–C11 |
| 2 | `media_stats_number` | 请求名与返回名一致 | 返回 `action` 为 **`media_stats`**，与请求名不同 | C05/C06 |
| 3 | `media_stats_number` 字段 | 未说明 | `*_count` 全为 **null**，`*_number` 才有值；可能已统一为 number | C05/C06 |
| 4 | `media_stats_number` 字段 | 无 `author_homepage` | 2026-10-28 观察到新增 **`author_homepage`** | C05/C06 |
| 5 | `media/comments/list` | 响应示例含 `cursor` | 2026-10-28 的样本中**已无 `cursor`**，只剩 `max_cursor` | C07/C08 |
| 6 | 评论 `total` | 未说明 | **`total` 包含回复**；`reply_pages=-1` 只返回一级评论 | raw4 截图 + C07 |
| 7 | 评论接口 | 未说明 | 可能出现 **`total>0` 但 `result` 为空**；`media/comments` 返回 `comments_str="暂无评论"` | C07/C08、raw6 C01/C02 |
| 8 | 小红书主页 | 说支持作者名、签名、交互数 | 实测只有 12 个字段，**没有头像、背景、位置** | C02 |
| 9 | 列表 vs 详情字段形态 | 未说明 | 抖音列表 `cover`/`download_urls` 是**数组**，详情是**字符串**；小红书列表 `cover` 是字符串 | C03/C04/C05/C06 |
| 10 | 列表播放数 | 抖音列表"不支持返回播放数" | 抖音返回 `play_count=0` 作为占位；小红书**无该字段**。播放数只在详情返回 | C03/C04/C05 |
| 11 | 异步模式 | "所有接口支持异步" | 2026-10-28：小红书**列表**异步两次失败（结果为字符串，`RESULT_VALIDATION_FAILED`）；主页与详情异步成功。**可能是暂时现象** | C10、raw5 C02/C04/C06 |
| 12 | 列表条目字段 | 未说明 | **条目字段不保证齐全**：第二页部分条目没有 `text` | raw6 C03 |
| 13 | 游标类型 | 未说明 | 抖音列表 `max_cursor` 是**整数**；小红书列表与评论是**字符串**；不得互转 | C03/C04/C07/C08 |
| 14 | 错误响应 | 未说明 | 无效抖音链接、私密/已删除内容的视频详情都返回 **HTTP 500** `RESULT_VALIDATION_FAILED`（`result` 为 null）；错误 Key 返回 **HTTP 400** `INVALID_REQUEST`。都不能按常规 404/401 处理 | raw7 C19/C20；raw10 V1 |
| 15 | 异步稳定性 | "所有接口支持异步" | 2026-10-28：8 个 tuple 中 5 个可用（抖音主页/详情、小红书主页/详情/评论）；**抖音列表、抖音评论、小红书列表**异步失败，重新查询旧任务仍为 `failed`。不是轮询间隔问题，**可能是供应商缺陷** | raw8 R1–R4、A1–A3；raw9 A4/A5 |
| 16 | 小红书评论分页 | 每页约 20 条 | 实测 `total=28` 只返回 2 条、`has_more=0`；另一条 `total=31` 只返回 4 条。**无法翻页** | raw7 C05、raw8 N2 |
| 17 | 快手支持范围 | 主页、列表、视频详情、摘要为支持；评论/关键词/热榜不支持 | 2026-10-28：主页 12 字段（无头像/背景/位置）、视频详情 24 字段成功；**列表可分页**（23 条 → 20 条），游标为科学计数法字符串；评论返回 500 | raw12 K1–K5、raw13 L3/L4 |
| 18 | 视频号支持范围 | 仅单条视频与摘要；主页/列表/评论不支持 | 2026-10-28：视频详情 23 字段成功；`download_urls` 为**空字符串**，无直接下载地址；评论返回 500 | raw12 W1–W3 |

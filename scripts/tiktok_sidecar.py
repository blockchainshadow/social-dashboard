#!/usr/bin/env python3
# TikTok 数据 sidecar：供 fetch-tiktok.mjs 调用
# 用法: .venv/bin/python scripts/tiktok_sidecar.py @handle
# 输出: stdout 一行 JSON；日志走 stderr
# 原理：TikTokApi 创建通过 WAF 验证的真实浏览器会话（支持代理），
#       再用该会话打开用户主页，提取页面内嵌的 __UNIVERSAL_DATA_FOR_REHYDRATION__。
# 可选环境变量：MS_TOKEN（提高稳定性）、TIKTOK_PROXY（如 http://127.0.0.1:7897）

import asyncio
import json
import os
import re
import sys


async def run(handle: str) -> None:
    from TikTokApi import TikTokApi

    # 修正库内 goto 等待策略：WAF 挑战页的 load 事件不会触发，
    # 改为 domcontentloaded + 120s，挑战 JS 会在页面内继续执行
    from playwright.async_api import Page

    _orig_goto = Page.goto

    async def _goto(self, url, **kw):
        kw.setdefault("timeout", 120000)
        kw.setdefault("wait_until", "domcontentloaded")
        return await _orig_goto(self, url, **kw)

    Page.goto = _goto

    ms_token = os.environ.get("MS_TOKEN")
    kwargs = {"num_sessions": 1, "sleep_after": 3, "headless": True, "timeout": 60000}
    if ms_token:
        kwargs["ms_tokens"] = [ms_token]
    proxy = os.environ.get("TIKTOK_PROXY")
    if proxy:
        kwargs["proxies"] = [{"server": proxy}]

    api = TikTokApi()
    try:
        await api.create_sessions(**kwargs)
        if not api.sessions:
            raise RuntimeError("浏览器会话创建失败")
        page = api.sessions[0].page

        await page.goto(
            f"https://www.tiktok.com/{handle}",
            wait_until="domcontentloaded",
            timeout=60000,
        )
        # 等待内嵌数据出现（WAF 挑战通过后才会渲染真实页面）
        try:
            await page.wait_for_selector(
                "script#__UNIVERSAL_DATA_FOR_REHYDRATION__", timeout=45000
            )
        except Exception:
            pass
        html = await page.content()

        m = re.search(
            r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(\{.+?\})</script>',
            html,
            re.S,
        )
        if not m:
            raise RuntimeError("未能从页面提取数据（可能触发验证码或网络不通）")
        ud = (
            json.loads(m.group(1))
            .get("__DEFAULT_SCOPE__", {})
            .get("webapp.user-detail", {})
        )
        user_info = ud.get("userInfo") or {}
        user = user_info.get("user", {})
        stats = user_info.get("stats", {})
        if not user:
            raise RuntimeError("页面数据中无 userInfo")

        videos = []
        for it in ud.get("itemList") or []:
            st = it.get("stats", {}) or {}
            videos.append(
                {
                    "id": it.get("id"),
                    "title": (it.get("desc") or "")[:200],
                    "views": st.get("playCount"),
                    "likes": st.get("diggCount"),
                    "comments": st.get("commentCount"),
                    "shares": st.get("shareCount"),
                    "createTime": it.get("createTime"),
                    "duration": (it.get("video") or {}).get("duration"),
                }
            )

        out = {
            "user": {
                "nickname": user.get("nickname"),
                "uniqueId": user.get("uniqueId"),
                "avatar": user.get("avatarLarger") or user.get("avatarMedium"),
                "bio": user.get("signature"),
                "verified": user.get("verified"),
                "followers": stats.get("followerCount"),
                "hearts": stats.get("heartCount"),
                "following": stats.get("followingCount"),
                "videoCount": stats.get("videoCount"),
            },
            "videos": videos,
        }
        print(json.dumps(out, ensure_ascii=False))
    finally:
        try:
            await api.close_sessions()
        except Exception:
            pass


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: tiktok_sidecar.py @handle", file=sys.stderr)
        sys.exit(2)
    asyncio.run(run(sys.argv[1]))

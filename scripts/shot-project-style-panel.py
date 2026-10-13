# -*- coding: utf-8 -*-
"""编辑页样式面板展开态截图：直插会话登录态，展开字幕样式折叠条与微调面板"""
import os
from playwright.sync_api import sync_playwright

TOKEN = "d1291d808367088adb07c4306a360d2e306dd1c725a81c3cb6d03a848e0995a4"
PROJECT_ID = "cmv2hfeqp0006pb7g3qn3ax8a"
OUT = r"D:\ai_play\temp_2\ui-preview-project-style.png"

os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", r"D:\ai_play\pw-browsers")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    context.add_cookies([{
        "name": "subflow_session",
        "value": TOKEN,
        "domain": "localhost",
        "path": "/",
        "httpOnly": True,
    }])
    page = context.new_page()
    page.goto(f"http://localhost:3000/project/{PROJECT_ID}", wait_until="networkidle")
    page.wait_for_timeout(1000)
    # 展开「字幕样式」折叠条
    page.get_by_text("字幕样式", exact=True).click()
    page.wait_for_timeout(400)
    # 展开样式微调面板
    try:
        page.get_by_text("微调当前样式", exact=True).click(timeout=3000)
        page.wait_for_timeout(400)
    except Exception:
        pass
    page.screenshot(path=OUT, full_page=False)
    print("SAVED", OUT)
    browser.close()

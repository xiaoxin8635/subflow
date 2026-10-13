# -*- coding: utf-8 -*-
"""字幕翻译抽屉打开态截图：进编辑页后点「字幕翻译」按钮，等滑入动画完成截全页"""
import os
from playwright.sync_api import sync_playwright

TOKEN = "d1291d808367088adb07c4306a360d2e306dd1c725a81c3cb6d03a848e0995a4"
PROJECT_ID = "cmv2hfeqp0006pb7g3qn3ax8a"
OUT = r"D:\ai_play\temp_2\ui-preview-translate-drawer.png"

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
    page.wait_for_timeout(800)
    page.get_by_role("button", name="字幕翻译").click()
    page.wait_for_timeout(700)
    page.screenshot(path=OUT, full_page=False)
    print("SAVED", OUT)
    browser.close()

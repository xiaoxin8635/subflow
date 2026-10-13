# -*- coding: utf-8 -*-
"""兑换额度页青绿主题改版截图：直插会话登录态，桌面视口截全页"""
import os
from playwright.sync_api import sync_playwright

TOKEN = "d1291d808367088adb07c4306a360d2e306dd1c725a81c3cb6d03a848e0995a4"
OUT = r"D:\ai_play\temp_2\ui-preview-redeem.png"

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
    page.goto("http://localhost:3000/dashboard/redeem", wait_until="networkidle")
    page.wait_for_timeout(800)
    page.screenshot(path=OUT, full_page=True)
    print("SAVED", OUT)
    browser.close()

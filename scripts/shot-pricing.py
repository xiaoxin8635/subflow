# -*- coding: utf-8 -*-
"""购买价格页青绿主题改版截图：公开页无需登录态，桌面视口截全页"""
import os
from playwright.sync_api import sync_playwright

OUT = r"D:\ai_play\temp_2\ui-preview-pricing.png"

os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", r"D:\ai_play\pw-browsers")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    page = context.new_page()
    page.goto("http://localhost:3000/pricing", wait_until="networkidle")
    page.wait_for_timeout(800)
    page.screenshot(path=OUT, full_page=True)
    print("SAVED", OUT)
    browser.close()

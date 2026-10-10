# =====================================================================
# 演示视频 TTS 语音生成脚本（Windows SAPI，Huihui 中文音色）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\gen-demo-tts.ps1
# 输出：test-media\demo-tts.wav
# =====================================================================
Add-Type -AssemblyName System.Speech

# 口播文案：模拟真实短视频开场白，覆盖润色/关键词高亮效果的典型场景
$script = "大家好，欢迎来到字幕工坊。你有没有过这样的烦恼？视频拍好了，打字幕却花了一整晚。现在，只要把视频传上来，人工智能就会自动听写每一句话，帮你纠错、加标点、标出重点词。你只需要改几个字，选一个喜欢的样式，点一下导出，带字幕的成片就完成了。创作更轻松，从字幕工坊开始。"

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice("Microsoft Huihui Desktop")
$synth.Rate = 0
$synth.SetOutputToWaveFile("D:\ai_play\temp_2\subflow\test-media\demo-tts.wav")
$synth.Speak($script)
$synth.Dispose()

Write-Host "TTS 完成：test-media\demo-tts.wav"

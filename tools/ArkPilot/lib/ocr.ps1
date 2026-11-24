$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and
    $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1'
} | Select-Object -First 1
function Await-Result($operation, [Type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    $task.GetAwaiter().GetResult()
}
$memory = [System.IO.MemoryStream]::new()
[Console]::OpenStandardInput().CopyTo($memory)
$memory.Position = 0
$stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($memory)
$decoder = Await-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await-Result ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($args[0]))
if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if ($null -eq $engine) { throw 'No Windows OCR language installed.' }
$result = Await-Result ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$lines = @(foreach ($line in $result.Lines) {
    $left = $bitmap.PixelWidth
    $top = $bitmap.PixelHeight
    $right = $bottom = 0
    foreach ($word in $line.Words) {
        $rect = $word.BoundingRect
        $left = [Math]::Min($left, $rect.X)
        $top = [Math]::Min($top, $rect.Y)
        $right = [Math]::Max($right, $rect.X + $rect.Width)
        $bottom = [Math]::Max($bottom, $rect.Y + $rect.Height)
    }
    if ($right -gt $left) {
        @{ label = $line.Text; box = @($left, $top, ($right - $left), ($bottom - $top)) }
    }
})
ConvertTo-Json -InputObject $lines -Depth 4 -Compress

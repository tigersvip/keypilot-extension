"""Reproduce the bundled models from pinned upstream inputs (requires onnx).

python tools/ocr/prepare-models.py --dddd-model common_old.onnx \
  --charset charset.json --tessdata eng.traineddata

The full charset is CHARSET_OLD from ddddocr's charsets.py, serialized as JSON.
No training, font-specific substitutions, or image-dependent weights are used.
"""
import argparse
import gzip
import hashlib
import json
import struct
from pathlib import Path

import numpy as np
import onnx
from onnx import helper, numpy_helper
from captcha_head import append_review_head, append_arithmetic_head

parser = argparse.ArgumentParser()
parser.add_argument('--dddd-model', type=Path, required=True)
parser.add_argument('--charset', type=Path, required=True)
parser.add_argument('--tessdata', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
target = root / 'src/ocr-models'
target.mkdir(exist_ok=True)

def digest(data):
    return hashlib.sha256(data).hexdigest()

raw_model = args.dddd_model.read_bytes()
raw_tessdata = args.tessdata.read_bytes()
assert digest(raw_model) == 'b8f2ad9cbc1f2e3922a6cb9459e30824e7e2467f3fb4fd61420640e34ea0bf68'
assert digest(raw_tessdata) == '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2'
alphabet = json.loads(args.charset.read_text(encoding='utf-8'))
assert len(alphabet) == 8210 and alphabet[0] == ''
indices = [i for i, c in enumerate(alphabet) if i == 0 or len(c) == 1 and 33 <= ord(c) <= 126]
assert len(indices) == 95 and len({alphabet[i] for i in indices}) == 95
model = onnx.load_from_string(raw_model)
changed = set()
for tensor in model.graph.initializer:
    array = numpy_helper.to_array(tensor)
    if tensor.name == '135_quantized':
        assert array.shape == (1024, 8210)
        tensor.CopyFrom(numpy_helper.from_array(array[:, indices].copy(), tensor.name))
        changed.add(tensor.name)
    elif tensor.name == '136':
        assert array.shape == (8210,)
        tensor.CopyFrom(numpy_helper.from_array(array[indices].copy(), tensor.name))
        changed.add(tensor.name)
    elif tensor.name in {'135_scale', '135_zero_point'}:
        assert array.ndim == 0  # This pinned model uses a single shared scale.
assert changed == {'135_quantized', '136'}
del model.graph.output[:]
model.graph.output.append(helper.make_tensor_value_info('387', onnx.TensorProto.FLOAT, ['sequence', 1, 95]))
review_head = append_review_head(model)
arithmetic_head = append_arithmetic_head(model)
onnx.checker.check_model(model)
slim_model = model.SerializeToString()
(target / 'captcha-ascii.onnx.gz').write_bytes(gzip.compress(slim_model, compresslevel=9, mtime=0))
(target / 'captcha-ascii.json').write_text(json.dumps([alphabet[i] for i in indices], separators=(',', ':')), encoding='utf-8')

# Tesseract's documented entry table: retain LSTM, unicharset, recoder,
# and version. Dictionary files are unnecessary for random CAPTCHA strings.
count = struct.unpack_from('<i', raw_tessdata)[0]
assert count == 24
offsets = struct.unpack_from('<' + 'q' * count, raw_tessdata, 4)
new_offsets, parts, position = [-1] * count, [], 4 + 8 * count
for index, offset in enumerate(offsets):
    if index in {17, 21, 22, 23}:
        assert offset >= 4 + 8 * count
        end = next((value for value in offsets[index + 1:] if value >= 0), len(raw_tessdata))
        assert offset < end <= len(raw_tessdata)
        part = raw_tessdata[offset:end]
        new_offsets[index] = position
        parts.append(part)
        position += len(part)
slim_tessdata = struct.pack('<i', count) + struct.pack('<' + 'q' * count, *new_offsets) + b''.join(parts)
(target / 'eng.traineddata.gz').write_bytes(gzip.compress(slim_tessdata, compresslevel=9, mtime=0))
metadata = {
    'ddddocrCommit': 'c40f56f95412e10bcb9bd0bd24411e92f896d238',
    'ddddocrSourceSha256': digest(raw_model),
    'tessdataFastCommit': '87416418657359cb625c412a48b6e1d6d41c29bd',
    'tessdataSourceSha256': digest(raw_tessdata),
    'changes': 'ASCII output and encoder retained unchanged; added synthetic-trained 63-class letter/digit and 17-class arithmetic uint8 heads sharing the frozen encoder. Tesseract LSTM dictionary sections removed.',
    'reviewHead': review_head,
    'arithmeticHead': arithmetic_head,
    'modelUncompressedBytes': len(slim_model),
    'tessdataUncompressedBytes': len(slim_tessdata),
    'assets': {path.name: {'bytes': path.stat().st_size, 'sha256': digest(path.read_bytes())}
               for path in sorted(target.iterdir()) if path.name != 'metadata.json'},
}
(target / 'metadata.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
print(json.dumps(metadata, indent=2))

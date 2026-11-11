"""Development-only frozen-feature CTC training. Never included in the extension.

Requires numpy, Pillow, onnx, onnxruntime and torch==2.7.0+cpu. Generate the corpus
with render-head-training.mts first. This script never fetches website images.
The shipped uint8 checkpoint is checked in; ordinary builds do not retrain it.
"""
import argparse, gzip, json, random
from pathlib import Path
import numpy as np
import onnx
import onnxruntime as ort
import torch
from PIL import Image
from onnx import helper, numpy_helper, TensorProto

parser = argparse.ArgumentParser()
parser.add_argument('--data', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--arithmetic', action='store_true', help='Train the 17-class arithmetic head instead of the letter/digit head.')
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
torch.set_num_threads(4)
torch.manual_seed(187 if args.arithmetic else 186)
random.seed(187 if args.arithmetic else 186)
alphabet = json.loads((root / 'src/ocr-models/captcha-ascii.json').read_text('utf-8'))
indices = [alphabet.index(char) for char in ['', *'0123456789+-*/=?']] if args.arithmetic else [i for i, char in enumerate(alphabet) if not char or char.isascii() and char.isalnum()]
mapping = {alphabet[index]: i for i, index in enumerate(indices)}
model = onnx.load_from_string(gzip.decompress((root / 'src/ocr-models/captcha-ascii.onnx.gz').read_bytes()))
weights = {v.name: numpy_helper.to_array(v) for v in model.graph.initializer}
model.graph.output.append(helper.make_tensor_value_info('380', TensorProto.FLOAT, [None, 1024]))
options = ort.SessionOptions()
options.intra_op_num_threads = 2
options.inter_op_num_threads = 1
session = ort.InferenceSession(model.SerializeToString(), options)
labels = json.loads((args.data / 'labels.json').read_text('utf-8'))
label_key = 'normalized' if args.arithmetic else 'text'
assert len(labels) == (2000 if args.arithmetic else 3000) and all(2 <= len(row[label_key]) <= 10 and all(c in mapping for c in row[label_key]) for row in labels)
features, targets = [], []
for i, row in enumerate(labels):
    image = Image.open(args.data / f'{i}.png').convert('RGB')
    image = image.resize(((int if args.arithmetic else round)(image.width * 64 / image.height), 64), Image.Resampling.LANCZOS).convert('L')
    x = session.run(['380'], {'input1': np.asarray(image, dtype=np.float32)[None, None] / 255})[0]
    features.append(torch.from_numpy(x.copy()))
    targets.append(torch.tensor([mapping[c] for c in row[label_key]], dtype=torch.long))
    if i % 500 == 0:
        print('Extracted features:', i, flush=True)
head = torch.nn.Linear(1024, len(indices))
with torch.no_grad():
    head.weight.copy_(torch.from_numpy(((weights['135_quantized'].astype('float32') - weights['135_zero_point']) * weights['135_scale'])[:, indices].T.copy()))
    head.bias.copy_(torch.from_numpy(weights['136'][indices].copy()))
initial = head.weight.detach().clone()
optimizer = torch.optim.AdamW(head.parameters(), lr=.0003, weight_decay=.001)
ctc = torch.nn.CTCLoss(blank=0, zero_infinity=True)
for epoch in range(1, 13 if args.arithmetic else 10):
    order = list(range(len(labels)))
    random.shuffle(order)
    losses = []
    for start in range(0, len(order), 48):
        batch = order[start:start + 48]
        inputs = torch.nn.utils.rnn.pad_sequence([features[i] for i in batch])
        lengths = torch.tensor([len(features[i]) for i in batch])
        target_lengths = torch.tensor([len(targets[i]) for i in batch])
        logits = head(inputs).log_softmax(-1)
        loss = ctc(logits, torch.cat([targets[i] for i in batch]), lengths, target_lengths) + .1 * ((head.weight - initial) ** 2).mean()
        optimizer.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(head.parameters(), 5)
        optimizer.step()
        losses.append(loss.item())
    print('Epoch:', epoch, 'loss:', float(np.mean(losses)), flush=True)
weight = head.weight.detach().numpy().T.copy()
low, high = min(0, float(weight.min())), max(0, float(weight.max()))
scale = np.array((high - low) / 255, dtype=np.float32)
zero = np.array(round(-low / scale.item()), dtype=np.uint8)
quantized = np.clip(np.round(weight / scale) + zero, 0, 255).astype(np.uint8)
np.savez_compressed(args.out, weight=quantized, scale=scale, zero=zero, bias=head.bias.detach().numpy().copy())
print('Saved quantized output head:', args.out)

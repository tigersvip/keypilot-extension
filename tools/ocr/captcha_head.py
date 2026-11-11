"""Append the small synthetic-trained head while retaining every original weight."""
import hashlib
from pathlib import Path
import numpy as np
from onnx import helper, numpy_helper, TensorProto

HEAD_INFO = {
    'encoder': 'frozen ddddocr common_old ASCII encoder; original output retained',
    'classes': 'CTC blank and 62 ASCII letters/digits, in original alphabet order',
    'training': '3000 synthetic images; nine fonts; clean, touching, overlap, warp, lines, mixed',
    'imageSeed': 202611186, 'optimizerSeed': 186, 'epochs': 9,
    'optimizer': 'AdamW, lr=0.0003, weight_decay=0.001, batch=48; CTC loss + 0.1*mean((W-W0)^2), gradient norm <=5',
    'runtimeWeights': 'uint8 per-tensor affine quantization; shared original activation quantization',
    'developmentSet': '192 synthetic images, seed 202611111; checkpoint selection only, no image used for training',
    'trainingRuntime': 'PyTorch 2.7.0+cpu, Python 3.12; development only',
    'scripts': ['tools/ocr/render-head-training.mts', 'tools/ocr/train-review-head.py'],
}

MATH_HEAD_INFO = {
    'encoder': 'frozen ddddocr common_old encoder; original and letter/digit outputs retained',
    'classes': ['', *'0123456789+-*/=?'],
    'training': '2000 locally rendered arithmetic expressions; four fonts, light/dark backgrounds, small rotation and sparse lines',
    'imageSeed': 202611187, 'optimizerSeed': 187, 'epochs': 12,
    'optimizer': HEAD_INFO['optimizer'],
    'runtimeWeights': HEAD_INFO['runtimeWeights'],
    'scripts': ['tools/ocr/benchmark-arithmetic.mts --render-only', 'tools/ocr/train-review-head.py --arithmetic'],
}

def _append_head(model, prefix, filename, classes):
    path = Path(__file__).with_name(filename)
    data = path.read_bytes()
    # A checked-in quantized checkpoint keeps ordinary packaging independent of training.
    digest = hashlib.sha256(data).hexdigest()
    with np.load(path, allow_pickle=False) as saved:
        arrays = {key: saved[key].copy() for key in ['weight', 'scale', 'zero', 'bias']}
    assert arrays['weight'].shape == (1024, classes) and arrays['weight'].dtype == np.uint8
    assert arrays['bias'].shape == (classes,) and arrays['bias'].dtype == np.float32
    assert arrays['scale'].shape == () and arrays['scale'].dtype == np.float32 and arrays['scale'] > 0
    assert arrays['zero'].shape == () and arrays['zero'].dtype == np.uint8
    assert np.isfinite(arrays['bias']).all() and np.isfinite(arrays['scale']).all()
    assert not any(v.name.startswith(prefix) for v in model.graph.initializer)
    for key, value in arrays.items():
        model.graph.initializer.append(numpy_helper.from_array(value, prefix + '_' + key))
    nodes = [
        helper.make_node('MatMulInteger', ['380_quantized', prefix+'_weight', '380_zero_point', prefix+'_zero'], [prefix+'_int']),
        helper.make_node('Cast', [prefix+'_int'], [prefix+'_float'], to=TensorProto.FLOAT),
        helper.make_node('Mul', ['380_scale', prefix+'_scale'], [prefix+'_scales']),
        helper.make_node('Mul', [prefix+'_float', prefix+'_scales'], [prefix+'_product']),
        helper.make_node('Add', [prefix+'_product', prefix+'_bias'], [prefix]),
    ]
    model.graph.node.extend(nodes)
    model.graph.output.append(helper.make_tensor_value_info(prefix, TensorProto.FLOAT, [None, classes]))
    return {'checkpointBytes': len(data), 'checkpointSha256': digest}

def append_review_head(model):
    return {**HEAD_INFO, **_append_head(model, 'kp_review', 'review-head.npz', 63)}

def append_arithmetic_head(model):
    return {**MATH_HEAD_INFO, **_append_head(model, 'kp_math', 'math-head.npz', 17)}

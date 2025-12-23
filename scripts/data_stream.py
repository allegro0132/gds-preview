import sys
import json
import base64


class NumpyEncoder(json.JSONEncoder):

    def default(self, obj):
        if hasattr(obj, "tolist"):
            return obj.tolist()
        return json.JSONEncoder.default(self, obj)


def send_binary_chunk(msg, binary_data, chunk_index, flow_control_step):
    msg['data'] = base64.b64encode(binary_data).decode('ascii')
    print("CHUNK_B64|" + json.dumps(msg, separators=(',', ':')))
    sys.stdout.flush()
    if flow_control_step != -1 and chunk_index % flow_control_step == 0:
        sys.stdin.readline()

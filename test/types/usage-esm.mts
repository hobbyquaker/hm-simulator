// The ESM entry point: default and named export are the same class.
import HmSim, {HmSim as Named} from '../../sim.mjs';

const sim: HmSim = new Named({behaviorPath: false});
const options: HmSim.Options = {config: {binrpcListenPort: 0}};
sim.close();
void options;

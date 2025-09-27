import C from '../../C.js'
import Monitor from './Monitor.js'
import MonitorConfig from './MonitorConfig.js'


class SystemMonitor {


    static async Start(){
        await C.run(Monitor)
        return
    }

    static async HUD(){
        await C.run(MonitorConfig)
        return
    }
    
}

export default SystemMonitor
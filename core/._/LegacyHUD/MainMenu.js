import Network from '../../Network.js'
import HUD from './HUD.js'
import WslManager from '../../WslManager.js'
import DownloadHUD from '../../DownloadHUD.js'
import System from '../../System.js'
import Git from '../../util/Git.js'
import SystemMonitor from '../../interfaces/SystemMonitor/SystemMonitor.js'
import ColorText from '../../util/ColorText.js'
import DirServerMenu from './DirServerMenu.js'
import MiscMenu from './MiscMenu.js'

//no AppHUD passar por padrão na props informações gerais do sistema (explorar a fundo cada vez mais a quantidade de informação passada, configuravel controle de performance, iniciar com o tipo do sistema...)

const SystemMonitorMenu = () => {
let final = {
title : 'SyManager > SystemMonitor',
options : [
{
name : 'Start',
action : async () => {
await SystemMonitor.Start()
HUD.displayMenu(SystemMonitorMenu)
}
},
{
name : 'HUD',
action : async () => {
await SystemMonitor.HUD()
HUD.displayMenu(SystemMonitorMenu)
}
}
]
}

final.options.push({
name : '<- Voltar',
action : () => {
HUD.displayMenu(MainMenu)
}
})

return final
}

const GitMenu = () => {
    let final = {
        title : `Sy Manager > GitMenu`,
        options : [
        {
            name : 'Git Full Setup',
            action : async () => {
                await Git.setup()
                await HUD.pressWait()
                HUD.displayMenu(GitMenu)

            }
        },
        {
            name : 'Git Config',
            action : async () => {
                await Git.configure()
                await HUD.pressWait()
                HUD.displayMenu(GitMenu)

            }
        },

        ]
    }

      final.options.push( {
        name : '<- Voltar',
        action : async () => {
            HUD.displayMenu(MainMenu)

        }
    })
  


    return final
}

const MainMenu = async () => {
    let final = {
        title : `Sy Manager`,
        options : [
        {
            name : 'Network Overview',
            action : async () => {
                await Network.Scan({log : true})
                await HUD.pressWait()
                HUD.displayMenu(MainMenu)

            }
        },
        {
            name : 'WSL',
            action : async () => {
                await WslManager.Run()
                HUD.displayMenu(MainMenu)

            }
        },
        {
            name : 'DownloadHUB',
            action : async () => {
                await DownloadHUD.Start()
                HUD.displayMenu(MainMenu)

            }
        }

        ]
    }

    if(System() == 'linux'){
        final.options.splice(1,1)
    }

    // -------------

    final.options.push( {
        name : 'Git',
        action : async () => {
            HUD.displayMenu(GitMenu)

        }
    })

    final.options.push({
name : 'SystemMonitor',
action : () => {HUD.displayMenu(SystemMonitorMenu)}
})

final.options.push({
    name : 'DirServer',
    action : () => {HUD.displayMenu(DirServerMenu)}
    })


        final.options.push({
            name : ColorText.yellow('Misc'),
            action :async  () => {await HUD.displayMenu(MiscMenu)}
            })
    
            if(System({detectLinuxDistribution : true}) == "ubuntu"){

    }

    final.options.push( {
        name : ColorText.red('Exit'),
        action : async () => {
            console.clear()
            process.exit()
        }
    })

    return final
}

export default MainMenu

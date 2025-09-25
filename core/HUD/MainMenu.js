import Network from '../Network.js'
import HUD from './HUD.js'
import WslManager from '../WslManager.js'
import DownloadHUD from '../DownloadHUD.js'
import System from '../System.js'
import Git from '../util/Git.js'

//no AppHUD passar por padrão na props informações gerais do sistema (explorar a fundo cada vez mais a quantidade de informação passada, configuravel controle de performance, iniciar com o tipo do sistema...)

const GitMenu = () => {
    let final = {
        title : `Sy Manager > GitMenu`,
        options : [
        {
            name : 'Git Setup',
            action : async () => {
                await Git.setup()
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

const MainMenu = () => {
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

    if(System({detectLinuxDistribution : true}) == "ubuntu"){
       
    
    }


    return final
}

export default MainMenu
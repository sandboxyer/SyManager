import Network from '../Network.js'
import HUD from './HUD.js'
import WslManager from '../WslManager.js'
import DownloadHUD from '../DownloadHUD.js'
import System from '../System.js'

//no AppHUD passar por padrão na props informações gerais do sistema (explorar a fundo cada vez mais a quantidade de informação passada, configuravel controle de performance, iniciar com o tipo do sistema...)

const MainMenu = () => {
    let final = {
        title : 'Sy Manager',
        options : [
        {
            name : 'Network',
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


    return final
}

export default MainMenu
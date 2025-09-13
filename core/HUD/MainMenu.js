import Network from '../Network.js'
import HUD from './HUD.js'
import WslManager from '../WslManager.js'
import DownloadHUD from '../DownloadHUD.js'

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


    return final
}

export default MainMenu